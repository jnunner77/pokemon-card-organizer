import { replacePerson } from '#domain/accounts/account-book.ts';
import { afterWrongPassword, minutesLocked } from '#domain/accounts/lockout.ts';
import { type Person, usernameKey } from '#domain/accounts/person.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { SignInError } from './errors.ts';

export type Checked = { readonly status: 'ok' | 'change'; readonly person: Person };

/**
 * Check a username and password, as signing in does: a locked username is refused, a wrong password
 * counts towards a lock, and the right one clears the count. A person who must choose a new
 * password first is 'change'; anyone else is signed in ('ok', their sign-in noted).
 */
export async function checkCredentials(deps: AccountDeps, rawUsername: string, password: string, ip: string): Promise<Result<Checked, SignInError>> {
  const username = usernameKey(rawUsername);
  const now = deps.clock.now();
  const minutes = minutesLocked(await deps.failures.get(username), now);
  if (minutes) return err({ code: 'LOCKED', minutes });
  const book = await deps.accounts.read();
  const person = book.users.find((u) => u.username === username && u.active);
  // One password check per attempt: a missing username is checked against a made-up hash, so it
  // takes as long as a wrong password and doesn't show which usernames exist.
  const right = await deps.hasher.verify(password, person?.passwordHash || null);
  if (!person || !person.passwordHash || !right) {
    const { record, lockedMs } = afterWrongPassword(await deps.failures.get(username), book.settings, deps.clock.now());
    await deps.failures.set(username, record);
    if (lockedMs !== null) {
      const mins = Math.round(lockedMs / 60_000);
      deps.securityLog.warn(`Locked the username "${username}" for ${mins} minutes after repeated wrong passwords`, { username, minutes: mins, locks: record.locks });
    }
    deps.authLog.warn(`Failed sign-in for "${username}"`, { username, ip });
    return err({ code: 'WRONG_PASSWORD' });
  }
  await deps.failures.clear(username);
  // The password was checked against the account as it was a moment ago: if it was reset, turned
  // off or removed meanwhile, the check no longer counts.
  const at = deps.clock.now().toISOString();
  const signedIn = await deps.accounts.change((draft): Result<Checked, SignInError> => {
    const current = draft.users.find((u) => u.id === person.id);
    if (!current || !current.active || current.passwordHash !== person.passwordHash) return err({ code: 'WRONG_PASSWORD' });
    if (current.mustChange) return ok({ status: 'change', person: current });
    return ok({ status: 'ok', person: replacePerson(draft, { ...current, lastSignInAt: at }) });
  });
  if (signedIn.ok && signedIn.value.status === 'ok') deps.authLog.info(`${person.username} signed in`, { username: person.username, ip });
  return signedIn;
}
