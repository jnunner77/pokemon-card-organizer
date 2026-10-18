import { isExpired, shouldNoteUse, tokenRole } from '#domain/accounts/api-token.ts';
import { isSessionLive, predatesPassword } from '#domain/accounts/session.ts';
import { ok } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { Identity } from './identity.ts';

export interface Credentials {
  /** The session cookie's token, if any. */
  readonly sessionToken?: string | undefined;
  /** An `Authorization: Bearer` API token, if any. */
  readonly bearer?: string | undefined;
}

/** Who is calling, if anyone; `badToken` when an API token was sent that doesn't work (forged, revoked or expired). */
export interface Identified {
  readonly identity: Identity | null;
  readonly badToken: boolean;
}

/** The person behind a session cookie or an API token. Using a session keeps it alive. */
export class IdentifyCaller {
  readonly #deps: Pick<AccountDeps, 'accounts' | 'sessions' | 'secrets' | 'clock'>;

  constructor(deps: Pick<AccountDeps, 'accounts' | 'sessions' | 'secrets' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(input: Credentials): Promise<Identified> {
    const d = this.#deps;
    const now = d.clock.now();
    if (input.bearer) {
      const hash = d.secrets.digest(input.bearer);
      const book = await d.accounts.read();
      const token = book.tokens.find((t) => t.hash === hash);
      if (!token || isExpired(token, now)) return { identity: null, badToken: true };
      const person = book.users.find((u) => u.id === token.userId && u.active);
      if (!person) return { identity: null, badToken: true };
      if (shouldNoteUse(token, now)) {
        const at = now.toISOString();
        await d.accounts.change((draft) => {
          draft.tokens = draft.tokens.map((t) => (t.id === token.id ? { ...t, lastUsedAt: at } : t));
          return ok(undefined);
        });
      }
      return { identity: { id: person.id, name: person.username, displayName: person.name, role: tokenRole(token.scope, person.role), via: 'token' }, badToken: false };
    }
    if (!input.sessionToken) return { identity: null, badToken: false };
    const hash = d.secrets.digest(input.sessionToken);
    const session = await d.sessions.find(hash);
    if (!session) return { identity: null, badToken: false };
    const book = await d.accounts.read();
    if (!isSessionLive(session, book.settings, now)) {
      await d.sessions.remove((s) => s.hash === hash);
      return { identity: null, badToken: false };
    }
    const person = book.users.find((u) => u.id === session.userId && u.active);
    if (!person) return { identity: null, badToken: false };
    if (predatesPassword(session, person.passwordSetAt)) {
      await d.sessions.remove((s) => s.hash === hash);
      return { identity: null, badToken: false };
    }
    await d.sessions.touch(hash, now.getTime());
    return { identity: { id: person.id, name: person.username, displayName: person.name, role: person.role, via: 'session' }, badToken: false };
  }
}
