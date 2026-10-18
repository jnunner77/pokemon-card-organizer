import { usableAdmins } from '#domain/accounts/account-book.ts';
import { isExpired, isStale } from '#domain/accounts/api-token.ts';
import type { SignInSettings } from '#domain/accounts/settings.ts';
import type { AccountDeps } from './deps.ts';

export interface AccountsHealthReport {
  readonly users: number;
  readonly admins: number;
  readonly adminsMustChange: number;
  readonly settings: SignInSettings;
  readonly sessions: number;
  readonly tokens: number;
  readonly tokensExpired: number;
  readonly tokensStale: number;
  readonly setupPending: boolean;
}

/** For the Overview's checks: who can sign in, and tokens that have expired or gone unused. */
export class AccountsHealth {
  readonly #deps: Pick<AccountDeps, 'accounts' | 'sessions' | 'setup' | 'clock'>;

  constructor(deps: Pick<AccountDeps, 'accounts' | 'sessions' | 'setup' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(): Promise<AccountsHealthReport> {
    const book = await this.#deps.accounts.read();
    const now = this.#deps.clock.now();
    const active = book.users.filter((u) => u.active);
    return {
      users: active.length,
      admins: usableAdmins(book.users).length,
      adminsMustChange: active.filter((u) => u.role === 'admin' && u.mustChange).length,
      settings: book.settings,
      sessions: (await this.#deps.sessions.list()).length,
      tokens: book.tokens.length,
      tokensExpired: book.tokens.filter((t) => isExpired(t, now)).length,
      tokensStale: book.tokens.filter((t) => isStale(t, now)).length,
      setupPending: (await this.#deps.setup.code()) !== null,
    };
  }
}
