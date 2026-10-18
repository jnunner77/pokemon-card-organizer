import type { AccountDeps } from './deps.ts';

/** Whether BINDER_PASSWORD from the environment still opens the "admin" account (the Overview warns if so). */
export class EnvPasswordWorks {
  readonly #deps: Pick<AccountDeps, 'accounts' | 'hasher'>;

  constructor(deps: Pick<AccountDeps, 'accounts' | 'hasher'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly envPassword: string | undefined }): Promise<boolean> {
    if (!input.envPassword) return false;
    const admin = (await this.#deps.accounts.read()).users.find((u) => u.username === 'admin' && u.passwordHash);
    return !!admin?.passwordHash && (await this.#deps.hasher.verify(input.envPassword, admin.passwordHash));
  }
}
