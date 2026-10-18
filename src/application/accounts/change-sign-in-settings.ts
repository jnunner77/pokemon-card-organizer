import { changeSettings, type SignInSettings } from '#domain/accounts/settings.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';

export interface ChangeSignInSettingsInput {
  readonly actor: string;
  readonly change: Partial<Record<keyof SignInSettings, number>>;
}

/** Change how long sessions last, the shortest password and the lockout. */
export class ChangeSignInSettings {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: ChangeSignInSettingsInput): Promise<Result<SignInSettings, AccountError>> {
    const changed = await this.#deps.accounts.change((draft) => {
      const next = changeSettings(draft.settings, input.change);
      if (next.ok) draft.settings = next.value;
      return next;
    });
    if (!changed.ok) return changed;
    this.#deps.adminLog.info(`${input.actor} changed sign-in settings`, { by: input.actor, ...input.change });
    return ok(changed.value);
  }
}
