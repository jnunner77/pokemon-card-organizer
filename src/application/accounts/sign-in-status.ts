import type { AccountDeps } from './deps.ts';

/** Whether the first administrator still needs creating with the setup code. */
export class SignInStatus {
  readonly #deps: Pick<AccountDeps, 'setup'>;

  constructor(deps: Pick<AccountDeps, 'setup'>) {
    this.#deps = deps;
  }

  async execute(): Promise<{ readonly setupRequired: boolean }> {
    return { setupRequired: (await this.#deps.setup.code()) !== null };
  }
}
