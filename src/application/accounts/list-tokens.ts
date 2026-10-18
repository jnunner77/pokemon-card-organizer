import type { AccountDeps } from './deps.ts';
import { type TokenView, tokenView } from './views.ts';

/** Every API token, without its secret. */
export class ListTokens {
  readonly #deps: Pick<AccountDeps, 'accounts' | 'clock'>;

  constructor(deps: Pick<AccountDeps, 'accounts' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(): Promise<{ readonly tokens: TokenView[] }> {
    const book = await this.#deps.accounts.read();
    const now = this.#deps.clock.now();
    return { tokens: book.tokens.map((t) => tokenView(t, book.users, now)) };
  }
}
