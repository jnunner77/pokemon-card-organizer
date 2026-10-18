import { addPerson } from '#domain/accounts/account-book.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';

/** BINDER_PASSWORD's shortest length. */
export const MIN_ENV_PASSWORD = 8;

export type BootstrapError = { readonly code: 'ENV_PASSWORD_TOO_SHORT'; readonly min: number };

/**
 * On start, while nobody can sign in yet: create the administrator "admin" from BINDER_PASSWORD or,
 * without it, issue a one-time setup code (returned, for the server to print).
 */
export class Bootstrap {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly envPassword?: string | undefined }): Promise<Result<{ readonly setupCode: string | null }, BootstrapError>> {
    const d = this.#deps;
    if ((await d.accounts.read()).users.length) return ok({ setupCode: null });
    const envPassword = input.envPassword;
    if (envPassword) {
      if (envPassword.length < MIN_ENV_PASSWORD) return err({ code: 'ENV_PASSWORD_TOO_SHORT', min: MIN_ENV_PASSWORD });
      const passwordHash = await d.hasher.hash(envPassword);
      const at = d.clock.now().toISOString();
      await d.accounts.change((draft) => addPerson(draft, { id: d.secrets.id(), username: 'admin', name: 'Administrator', role: 'admin', active: true, passwordHash, passwordSetAt: at, mustChange: false, createdAt: at, lastSignInAt: null }));
      d.authLog.warn('Created the administrator "admin" with the password from BINDER_PASSWORD. Sign in, then add your own account or change the password.');
      return ok({ setupCode: null });
    }
    const setupCode = d.secrets.setupCode();
    await d.setup.set(setupCode);
    d.authLog.warn(`No accounts yet. Open the ledger and create the first administrator with setup code ${setupCode}`);
    return ok({ setupCode });
  }
}
