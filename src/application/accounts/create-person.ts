import { addPerson } from '#domain/accounts/account-book.ts';
import { checkNewPassword } from '#domain/accounts/password.ts';
import { readName, readPassword, readUsername } from '#domain/accounts/person.ts';
import type { Role } from '#domain/accounts/role.ts';
import { err, type Result } from '#shared/result.ts';
import { ok } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';
import { type PersonView, viewOf } from './views.ts';

export interface CreatePersonInput {
  readonly actor: string;
  readonly username: string;
  readonly name: string;
  readonly role: Role;
  readonly password: string;
  /** They choose their own password before signing in. */
  readonly mustChange: boolean;
}

/** Add someone who can sign in. */
export class CreatePerson {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: CreatePersonInput): Promise<Result<PersonView, AccountError>> {
    const d = this.#deps;
    const username = readUsername(input.username);
    if (!username.ok) return username;
    const name = readName(input.name);
    if (!name.ok) return name;
    const password = readPassword(input.password);
    if (!password.ok) return password;
    const book = await d.accounts.read();
    if (book.users.some((u) => u.username === username.value)) return err({ code: 'USERNAME_TAKEN', username: username.value });
    const strong = checkNewPassword(input.password, username.value, book.settings.passwordMinLength);
    if (!strong.ok) return strong;
    const passwordHash = await d.hasher.hash(input.password);
    const at = d.clock.now().toISOString();
    const added = await d.accounts.change((draft) => addPerson(draft, { id: d.secrets.id(), username: username.value, name: name.value, role: input.role, active: true, passwordHash, passwordSetAt: at, mustChange: input.mustChange, createdAt: at, lastSignInAt: null }));
    if (!added.ok) return added;
    const u = added.value;
    d.adminLog.info(`${input.actor} added ${u.username} (${u.role})`, { by: input.actor, user: u.username, role: u.role });
    return ok(await viewOf(d, u));
  }
}
