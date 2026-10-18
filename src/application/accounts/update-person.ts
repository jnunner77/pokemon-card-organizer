import { changePerson } from '#domain/accounts/account-book.ts';
import { readName } from '#domain/accounts/person.ts';
import type { Role } from '#domain/accounts/role.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';
import { endSessionsOf } from './sessions.ts';
import { type PersonView, viewOf } from './views.ts';

export interface UpdatePersonInput {
  readonly actor: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly role?: Role | undefined;
  readonly active?: boolean | undefined;
}

/** Change someone's name or role, or turn their account off (which signs them out). */
export class UpdatePerson {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: UpdatePersonInput): Promise<Result<PersonView, AccountError>> {
    const d = this.#deps;
    let name: string | undefined;
    if (input.name !== undefined) {
      const read = readName(input.name);
      if (!read.ok) return read;
      name = read.value;
    }
    const changed = await d.accounts.change((draft) => changePerson(draft, input.id, { name, role: input.role, active: input.active }));
    if (!changed.ok) return changed;
    const u = changed.value;
    if (input.active === false) await endSessionsOf(d, u.id);
    const patch = { ...(name !== undefined ? { name } : {}), ...(input.role !== undefined ? { role: input.role } : {}), ...(input.active !== undefined ? { active: input.active } : {}) };
    d.adminLog.info(`${input.actor} changed ${u.username}`, { by: input.actor, user: u.username, ...patch });
    return ok(await viewOf(d, u));
  }
}
