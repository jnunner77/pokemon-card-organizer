import { replacePerson } from '#domain/accounts/account-book.ts';
import { checkNewPassword } from '#domain/accounts/password.ts';
import { type Person, readPassword } from '#domain/accounts/person.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { checkCredentials } from './credentials.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';
import { endSessionsOf, startSession, type Where } from './sessions.ts';

export interface ChangeOwnPasswordInput extends Where {
  readonly username: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

/**
 * Change your own password (also how someone with a temporary password chooses theirs): signs you
 * out everywhere else and in on this browser.
 */
export class ChangeOwnPassword {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: ChangeOwnPasswordInput): Promise<Result<{ readonly token: string; readonly maxAgeDays: number }, AccountError>> {
    const d = this.#deps;
    for (const pw of [input.currentPassword, input.newPassword]) {
      const length = readPassword(pw);
      if (!length.ok) return length;
    }
    const checked = await checkCredentials(d, input.username, input.currentPassword, input.ip);
    if (!checked.ok) return checked;
    if (input.newPassword === input.currentPassword) return err({ code: 'SAME_PASSWORD' });
    const { person } = checked.value;
    const settings = (await d.accounts.read()).settings;
    const strong = checkNewPassword(input.newPassword, person.username, settings.passwordMinLength);
    if (!strong.ok) return strong;
    const passwordHash = await d.hasher.hash(input.newPassword);
    const at = d.clock.now().toISOString();
    // The current password was checked a moment ago: if an administrator reset it, or the account
    // was turned off or removed meanwhile, nothing changes.
    const changed = await d.accounts.change((draft): Result<Person, AccountError> => {
      const current = draft.users.find((u) => u.id === person.id);
      if (!current || !current.active || current.passwordHash !== person.passwordHash) return err({ code: 'WRONG_PASSWORD' });
      return ok(replacePerson(draft, { ...current, passwordHash, passwordSetAt: at, mustChange: false, lastSignInAt: at }));
    });
    if (!changed.ok) return changed;
    const updated = changed.value;
    await endSessionsOf(d, updated.id);
    d.authLog.info(`${updated.username} changed their password`, { username: updated.username, ip: input.ip });
    const token = await startSession(d, updated, input);
    return ok({ token, maxAgeDays: settings.sessionMaxDays });
  }
}
