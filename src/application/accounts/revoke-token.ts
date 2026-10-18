import { removeToken } from '#domain/accounts/account-book.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';

/** Revoke an API token: requests with it are refused from now on. */
export class RevokeToken {
  readonly #deps: Pick<AccountDeps, 'accounts' | 'adminLog'>;

  constructor(deps: Pick<AccountDeps, 'accounts' | 'adminLog'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly id: string }): Promise<Result<void, AccountError>> {
    const removed = await this.#deps.accounts.change((draft) => removeToken(draft, input.id));
    if (!removed.ok) return removed;
    this.#deps.adminLog.info(`${input.actor} revoked API token "${removed.value.name}"`, { by: input.actor });
    return ok(undefined);
  }
}
