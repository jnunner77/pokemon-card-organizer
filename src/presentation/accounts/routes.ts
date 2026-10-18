import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireRole } from '#application/access.ts';
import type { ChangeOwnPassword } from '#application/accounts/change-own-password.ts';
import type { ChangeSignInSettings } from '#application/accounts/change-sign-in-settings.ts';
import type { CreatePerson } from '#application/accounts/create-person.ts';
import type { CreateToken } from '#application/accounts/create-token.ts';
import type { DeletePerson } from '#application/accounts/delete-person.ts';
import type { EndSession } from '#application/accounts/end-session.ts';
import type { AccountError } from '#application/accounts/errors.ts';
import type { Identity } from '#application/accounts/identity.ts';
import type { ListPeople } from '#application/accounts/list-people.ts';
import type { ListSessions } from '#application/accounts/list-sessions.ts';
import type { ListTokens } from '#application/accounts/list-tokens.ts';
import type { RevokeToken } from '#application/accounts/revoke-token.ts';
import type { SetPersonPassword } from '#application/accounts/set-person-password.ts';
import type { SetUpFirstAdmin } from '#application/accounts/set-up-first-admin.ts';
import type { SignIn } from '#application/accounts/sign-in.ts';
import type { SignInStatus } from '#application/accounts/sign-in-status.ts';
import type { SignOut } from '#application/accounts/sign-out.ts';
import type { SignPersonOut } from '#application/accounts/sign-person-out.ts';
import type { UpdatePerson } from '#application/accounts/update-person.ts';
import { isTokenScope, TOKEN_DAYS, TOKEN_SCOPES } from '#domain/accounts/api-token.ts';
import { isRole, ROLES } from '#domain/accounts/role.ts';
import { SETTING_NAMES, type SignInSettings } from '#domain/accounts/settings.ts';
import { ok, type Result } from '#shared/result.ts';
import { readJsonBody } from '../http/body.ts';
import type { IdentityResolver } from '../http/caller.ts';
import type { ClientResolver } from '../http/client.ts';
import { clearedCookie, readCookie, signInCookie } from '../http/cookies.ts';
import { accessFailure, badRequest, bodyFailure } from '../http/errors.ts';
import { boolField, choiceField, type Fields, fieldsOf, numberField, optionalBool, optionalText, textField } from '../http/fields.ts';
import { sendFailure, sendJson, sendNoContent } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { accountFailure, SIGN_IN_OFF } from './errors.ts';

export const SESSION_COOKIE = 'binder_session';
/** Longest username or setup code accepted when signing in (their own rules apply after). */
const MAX_SIGN_IN_TEXT = 64;

/** Everything people and sign-in need, when sign-in is turned on. */
export interface AccountUseCases {
  readonly status: Pick<SignInStatus, 'execute'>;
  readonly signIn: Pick<SignIn, 'execute'>;
  readonly changeOwnPassword: Pick<ChangeOwnPassword, 'execute'>;
  readonly setUpFirstAdmin: Pick<SetUpFirstAdmin, 'execute'>;
  readonly signOut: Pick<SignOut, 'execute'>;
  readonly listPeople: Pick<ListPeople, 'execute'>;
  readonly createPerson: Pick<CreatePerson, 'execute'>;
  readonly updatePerson: Pick<UpdatePerson, 'execute'>;
  readonly setPersonPassword: Pick<SetPersonPassword, 'execute'>;
  readonly signPersonOut: Pick<SignPersonOut, 'execute'>;
  readonly deletePerson: Pick<DeletePerson, 'execute'>;
  readonly changeSettings: Pick<ChangeSignInSettings, 'execute'>;
  readonly listSessions: Pick<ListSessions, 'execute'>;
  readonly endSession: Pick<EndSession, 'execute'>;
  readonly listTokens: Pick<ListTokens, 'execute'>;
  readonly createToken: Pick<CreateToken, 'execute'>;
  readonly revokeToken: Pick<RevokeToken, 'execute'>;
}

export interface AccountRouteDeps {
  readonly identify: IdentityResolver;
  readonly client: ClientResolver;
  /** Null with sign-in turned off (AUTH=off): only /auth/me answers, and the people pages say it's off. */
  readonly accounts: AccountUseCases | null;
}

/** Signing in and out (/auth/…) and Administration → People, sessions and API tokens, relative to /api. */
export function accountRoutes(deps: AccountRouteDeps): Router {
  const { accounts } = deps;

  /** The administrator calling, or null once refused. */
  const admin = (req: IncomingMessage, res: ServerResponse): { readonly who: Identity; readonly accounts: AccountUseCases } | null => {
    const identity = deps.identify(req);
    const allowed = requireRole(identity, 'admin');
    if (!allowed.ok || !identity) {
      req.resume();
      sendFailure(res, accessFailure(allowed.ok ? { code: 'SIGN_IN_REQUIRED' } : allowed.error));
      return null;
    }
    if (!accounts) {
      req.resume();
      sendFailure(res, SIGN_IN_OFF);
      return null;
    }
    return { who: identity, accounts };
  };
  /** The JSON body's fields (only those allowed), or null once answered. */
  const body = async (req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): Promise<Fields | null> => {
    const read = await readJsonBody(req);
    if (!read.ok) {
      sendFailure(res, bodyFailure(read.error));
      return null;
    }
    const fields = fieldsOf(read.value, allowed);
    if (fields.ok) return fields.value;
    sendFailure(res, badRequest(fields.error));
    return null;
  };
  /** A field's value, or null once a bad one is answered. */
  const value = <T>(res: ServerResponse, r: Result<T, string>): { readonly v: T } | null => {
    if (r.ok) return { v: r.value };
    sendFailure(res, badRequest(r.error));
    return null;
  };
  const answer = <T>(res: ServerResponse, r: Result<T, AccountError>, status = 200): void => {
    if (r.ok) sendJson(res, status, r.value);
    else sendFailure(res, accountFailure(r.error));
  };
  const startSession = (req: IncomingMessage, res: ServerResponse, token: string, maxAgeDays: number): void => {
    res.setHeader('Set-Cookie', signInCookie(SESSION_COOKIE, token, { secure: deps.client(req).secure, maxAgeMs: maxAgeDays * 86_400_000 }));
  };
  const where = (req: IncomingMessage) => ({ ip: deps.client(req).ip, agent: req.headers['user-agent'] ?? '' });

  const router = new Router().add('GET', '/auth/me', async (req, res) => {
    const c = deps.identify(req);
    sendJson(res, 200, {
      authEnabled: accounts !== null,
      setupRequired: accounts ? (await accounts.status.execute()).setupRequired : false,
      user: c ? { username: c.name, name: c.displayName, role: c.role, via: c.via } : null,
    });
  });

  if (accounts) {
    router
      .add('POST', '/auth/login', async (req, res) => {
        const f = await body(req, res, ['username', 'password']);
        if (!f) return;
        const username = value(res, textField(f, 'username', { max: MAX_SIGN_IN_TEXT }));
        const password = username && value(res, textField(f, 'password'));
        if (!username || !password) return;
        const r = await accounts.signIn.execute({ username: username.v.trim(), password: password.v, ...where(req) });
        if (!r.ok) return sendFailure(res, accountFailure(r.error));
        if (r.value.status === 'ok') startSession(req, res, r.value.token, r.value.maxAgeDays);
        sendJson(res, 200, { status: r.value.status });
      })
      .add('POST', '/auth/password', async (req, res) => {
        const f = await body(req, res, ['username', 'currentPassword', 'newPassword']);
        if (!f) return;
        const username = value(res, textField(f, 'username', { max: MAX_SIGN_IN_TEXT }));
        const current = username && value(res, textField(f, 'currentPassword'));
        const next = current && value(res, textField(f, 'newPassword'));
        if (!username || !current || !next) return;
        const r = await accounts.changeOwnPassword.execute({ username: username.v.trim(), currentPassword: current.v, newPassword: next.v, ...where(req) });
        if (!r.ok) return sendFailure(res, accountFailure(r.error));
        startSession(req, res, r.value.token, r.value.maxAgeDays);
        sendJson(res, 200, { status: 'ok' });
      })
      .add('POST', '/auth/setup', async (req, res) => {
        const f = await body(req, res, ['setupCode', 'username', 'name', 'password']);
        if (!f) return;
        const code = value(res, textField(f, 'setupCode', { max: MAX_SIGN_IN_TEXT }));
        const username = code && value(res, textField(f, 'username'));
        const name = username && value(res, textField(f, 'name'));
        const password = name && value(res, textField(f, 'password'));
        if (!code || !username || !name || !password) return;
        const r = await accounts.setUpFirstAdmin.execute({ setupCode: code.v, username: username.v, name: name.v, password: password.v, ...where(req) });
        if (!r.ok) return sendFailure(res, accountFailure(r.error));
        startSession(req, res, r.value.token, r.value.maxAgeDays);
        sendJson(res, 200, { status: 'ok' });
      })
      .add('POST', '/auth/logout', async (req, res) => {
        req.resume();
        const token = readCookie(req, SESSION_COOKIE);
        if (token) await accounts.signOut.execute({ token });
        res.setHeader('Set-Cookie', clearedCookie(SESSION_COOKIE));
        sendNoContent(res);
      });
  }

  return (
    router
      // ---- people ----
      .add('GET', '/admin/users', async (req, res) => {
        const a = admin(req, res);
        if (a) sendJson(res, 200, await a.accounts.listPeople.execute());
      })
      .add('POST', '/admin/users', async (req, res) => {
        const a = admin(req, res);
        if (!a) return;
        const f = await body(req, res, ['username', 'name', 'role', 'password', 'mustChange']);
        if (!f) return;
        const username = value(res, textField(f, 'username'));
        const name = username && value(res, textField(f, 'name'));
        const role = name && value(res, choiceField(f, 'role', isRole, ROLES));
        const password = role && value(res, textField(f, 'password'));
        const mustChange = password && value(res, boolField(f, 'mustChange', true));
        if (!username || !name || !role || !password || !mustChange) return;
        answer(res, await a.accounts.createPerson.execute({ actor: a.who.name, username: username.v, name: name.v, role: role.v, password: password.v, mustChange: mustChange.v }), 201);
      })
      .add('PATCH', '/admin/users/:id', async (req, res, p) => {
        const a = admin(req, res);
        if (!a) return;
        const f = await body(req, res, ['name', 'role', 'active']);
        if (!f) return;
        const name = value(res, optionalText(f, 'name'));
        const role = name && value(res, f['role'] === undefined ? ok(undefined) : choiceField(f, 'role', isRole, ROLES));
        const active = role && value(res, optionalBool(f, 'active'));
        if (!name || !role || !active) return;
        answer(res, await a.accounts.updatePerson.execute({ actor: a.who.name, id: p['id'] ?? '', name: name.v, role: role.v, active: active.v }));
      })
      .add('POST', '/admin/users/:id/password', async (req, res, p) => {
        const a = admin(req, res);
        if (!a) return;
        const f = await body(req, res, ['password', 'mustChange']);
        if (!f) return;
        const password = value(res, textField(f, 'password'));
        const mustChange = password && value(res, boolField(f, 'mustChange', true));
        if (!password || !mustChange) return;
        answer(res, await a.accounts.setPersonPassword.execute({ actor: a.who.name, id: p['id'] ?? '', password: password.v, mustChange: mustChange.v }));
      })
      .add('POST', '/admin/users/:id/signout', async (req, res, p) => {
        const a = admin(req, res);
        if (!a) return;
        req.resume();
        sendJson(res, 200, await a.accounts.signPersonOut.execute({ actor: a.who.name, id: p['id'] ?? '' }));
      })
      .add('DELETE', '/admin/users/:id', async (req, res, p) => {
        const a = admin(req, res);
        if (!a) return;
        req.resume();
        const r = await a.accounts.deletePerson.execute({ actor: a.who.name, id: p['id'] ?? '' });
        if (r.ok) sendNoContent(res);
        else sendFailure(res, accountFailure(r.error));
      })
      .add('PUT', '/admin/settings', async (req, res) => {
        const a = admin(req, res);
        if (!a) return;
        const f = await body(req, res, SETTING_NAMES);
        if (!f) return;
        const change: Partial<Record<keyof SignInSettings, number>> = {};
        for (const key of SETTING_NAMES) {
          if (f[key] === undefined) continue;
          const n = value(res, numberField(f, key));
          if (!n) return;
          change[key] = n.v;
        }
        answer(res, await a.accounts.changeSettings.execute({ actor: a.who.name, change }));
      })

      // ---- sessions and API tokens ----
      .add('GET', '/admin/sessions', async (req, res) => {
        const a = admin(req, res);
        if (a) sendJson(res, 200, await a.accounts.listSessions.execute());
      })
      .add('DELETE', '/admin/sessions/:id', async (req, res, p) => {
        const a = admin(req, res);
        if (!a) return;
        req.resume();
        await a.accounts.endSession.execute({ actor: a.who.name, id: p['id'] ?? '' });
        sendNoContent(res);
      })
      .add('GET', '/admin/tokens', async (req, res) => {
        const a = admin(req, res);
        if (a) sendJson(res, 200, await a.accounts.listTokens.execute());
      })
      .add('POST', '/admin/tokens', async (req, res) => {
        const a = admin(req, res);
        if (!a) return;
        const f = await body(req, res, ['name', 'userId', 'scope', 'expiresInDays']);
        if (!f) return;
        const name = value(res, textField(f, 'name'));
        const userId = name && value(res, textField(f, 'userId'));
        const scope = userId && value(res, choiceField(f, 'scope', isTokenScope, TOKEN_SCOPES, 'read'));
        const days = scope && value(res, numberField(f, 'expiresInDays', TOKEN_DAYS.default));
        if (!name || !userId || !scope || !days) return;
        answer(res, await a.accounts.createToken.execute({ actor: a.who.name, name: name.v, userId: userId.v, scope: scope.v, expiresInDays: days.v }), 201);
      })
      .add('DELETE', '/admin/tokens/:id', async (req, res, p) => {
        const a = admin(req, res);
        if (!a) return;
        req.resume();
        const r = await a.accounts.revokeToken.execute({ actor: a.who.name, id: p['id'] ?? '' });
        if (r.ok) sendNoContent(res);
        else sendFailure(res, accountFailure(r.error));
      })
  );
}
