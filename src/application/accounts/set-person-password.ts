import { findPerson, replacePerson } from '#domain/accounts/account-book.ts';
import { checkNewPassword } from '#domain/accounts/password.ts';
import { readPassword } from '#domain/accounts/person.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';
import { endSessionsOf } from './sessions.ts';
import { type PersonView, viewOf } from './views.ts';

export interface SetPersonPasswordInput {
  readonly actor: string;
  readonly id: string;
  readonly password: string;
  readonly mustChange: boolean;
}

/** An administrator sets someone's password: their lock is lifted and they're signed out everywhere. */
export class SetPersonPassword {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: SetPersonPasswordInput): Promise<Result<PersonView, AccountError>> {
    const d = this.#deps;
    const password = readPassword(input.password);
    if (!password.ok) return password;
    const book = await d.accounts.read();
    const found = findPerson(book, input.id);
    if (!found.ok) return found;
    const strong = checkNewPassword(input.password, found.value.username, book.settings.passwordMinLength);
    if (!strong.ok) return strong;
    const passwordHash = await d.hasher.hash(input.password);
    const at = d.clock.now().toISOString();
    const changed = await d.accounts.change((draft) => {
      const current = findPerson(draft, input.id);
      return current.ok ? ok(replacePerson(draft, { ...current.value, passwordHash, passwordSetAt: at, mustChange: input.mustChange })) : current;
    });
    if (!changed.ok) return changed;
    const u = changed.value;
    await d.failures.clear(u.username);
    await endSessionsOf(d, u.id);
    d.adminLog.info(`${input.actor} set a new password for ${u.username}`, { by: input.actor, user: u.username, mustChange: input.mustChange });
    return ok(await viewOf(d, u));
  }
}
