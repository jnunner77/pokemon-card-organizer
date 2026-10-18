import { removePerson } from '#domain/accounts/account-book.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';
import { endSessionsOf } from './sessions.ts';

/** Remove someone, with their API tokens and sessions. */
export class DeletePerson {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly id: string }): Promise<Result<void, AccountError>> {
    const d = this.#deps;
    const removed = await d.accounts.change((draft) => removePerson(draft, input.id));
    if (!removed.ok) return removed;
    await endSessionsOf(d, input.id);
    d.adminLog.info(`${input.actor} removed ${removed.value.username}`, { by: input.actor, user: removed.value.username });
    return ok(undefined);
  }
}
