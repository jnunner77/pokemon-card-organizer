import type { AccountDeps } from './deps.ts';

/** Sign out of this browser: its session ends. */
export class SignOut {
  readonly #deps: Pick<AccountDeps, 'sessions' | 'secrets'>;

  constructor(deps: Pick<AccountDeps, 'sessions' | 'secrets'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly token: string }): Promise<void> {
    const hash = this.#deps.secrets.digest(input.token);
    await this.#deps.sessions.remove((s) => s.hash === hash);
  }
}
