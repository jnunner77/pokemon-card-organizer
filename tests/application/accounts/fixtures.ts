import type { AccountDeps } from '#application/accounts/deps.ts';
import { AccountsHealth } from '#application/accounts/accounts-health.ts';
import { Bootstrap } from '#application/accounts/bootstrap.ts';
import { ChangeOwnPassword } from '#application/accounts/change-own-password.ts';
import { ChangeSignInSettings } from '#application/accounts/change-sign-in-settings.ts';
import { CreatePerson } from '#application/accounts/create-person.ts';
import { CreateToken } from '#application/accounts/create-token.ts';
import { DeletePerson } from '#application/accounts/delete-person.ts';
import { EndSession } from '#application/accounts/end-session.ts';
import { EnvPasswordWorks } from '#application/accounts/env-password-works.ts';
import { IdentifyCaller } from '#application/accounts/identify-caller.ts';
import { ListPeople } from '#application/accounts/list-people.ts';
import { ListSessions } from '#application/accounts/list-sessions.ts';
import { ListTokens } from '#application/accounts/list-tokens.ts';
import { RevokeToken } from '#application/accounts/revoke-token.ts';
import { SetPersonPassword } from '#application/accounts/set-person-password.ts';
import { SetUpFirstAdmin } from '#application/accounts/set-up-first-admin.ts';
import { SignIn } from '#application/accounts/sign-in.ts';
import { SignInStatus } from '#application/accounts/sign-in-status.ts';
import { SignOut } from '#application/accounts/sign-out.ts';
import { SignPersonOut } from '#application/accounts/sign-person-out.ts';
import { UpdatePerson } from '#application/accounts/update-person.ts';
import { CountingSecrets, MemoryAccountStore, MemoryFailedSignIns, MemoryFirstRunSetup, MemorySessionStore, PlainHasher } from '#infrastructure/memory/accounts.ts';

export const START = Date.parse('2026-10-18T12:00:00.000Z');

/** The accounts use cases over memory, with a clock tests move and what each log was told. */
export function setUpAccounts() {
  const clock = { at: START };
  const logged = { auth: [] as string[], admin: [] as string[], security: [] as string[] };
  const log = (into: string[]) => ({ info: (m: string) => void into.push(m), warn: (m: string) => void into.push(m) });
  const sessions = new MemorySessionStore();
  const hasher = new PlainHasher();
  /** While set, password checks wait for it: what happens meanwhile happens mid-check. */
  const hold: { until: Promise<void> | null } = { until: null };
  const slowHasher = {
    hash: (password: string) => hasher.hash(password),
    verify: async (password: string, stored: string | null) => {
      const right = await hasher.verify(password, stored);
      if (hold.until) await hold.until;
      return right;
    },
  };
  const deps: AccountDeps = {
    accounts: new MemoryAccountStore(),
    sessions,
    failures: new MemoryFailedSignIns(),
    setup: new MemoryFirstRunSetup(),
    hasher: slowHasher,
    secrets: new CountingSecrets(),
    clock: { now: () => new Date(clock.at) },
    authLog: log(logged.auth),
    adminLog: log(logged.admin),
    securityLog: log(logged.security),
  };
  const use = {
    bootstrap: new Bootstrap(deps),
    identify: new IdentifyCaller(deps),
    status: new SignInStatus(deps),
    signIn: new SignIn(deps),
    changeOwnPassword: new ChangeOwnPassword(deps),
    setUpFirstAdmin: new SetUpFirstAdmin(deps),
    signOut: new SignOut(deps),
    listPeople: new ListPeople(deps),
    createPerson: new CreatePerson(deps),
    updatePerson: new UpdatePerson(deps),
    setPersonPassword: new SetPersonPassword(deps),
    signPersonOut: new SignPersonOut(deps),
    deletePerson: new DeletePerson(deps),
    changeSettings: new ChangeSignInSettings(deps),
    listSessions: new ListSessions(deps),
    endSession: new EndSession(deps),
    listTokens: new ListTokens(deps),
    createToken: new CreateToken(deps),
    revokeToken: new RevokeToken(deps),
    health: new AccountsHealth(deps),
    envPasswordWorks: new EnvPasswordWorks(deps),
  };
  const where = { ip: '1.2.3.4', agent: 'test' };
  /** "admin" from BINDER_PASSWORD, and someone else with the role given. */
  const withAdmin = async () => {
    await use.bootstrap.execute({ envPassword: 'start password 1' });
  };
  const add = async (username: string, role: 'admin' | 'editor' | 'viewer', o: { password?: string; mustChange?: boolean } = {}) => {
    const r = await use.createPerson.execute({ actor: 'admin', username, name: username, role, password: o.password ?? 'a good password', mustChange: o.mustChange ?? false });
    if (!r.ok) throw new Error(`couldn't add ${username}: ${r.error.code}`);
    return r.value;
  };
  const signIn = async (username: string, password: string) => {
    const r = await use.signIn.execute({ username, password, ...where });
    if (!r.ok || r.value.status !== 'ok') throw new Error(`couldn't sign in as ${username}`);
    return r.value.token;
  };
  return { deps, use, clock, logged, sessions, hasher, hold, where, withAdmin, add, signIn };
}
