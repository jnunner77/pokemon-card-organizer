import type { Result } from '#shared/result.ts';
import { ok } from '#shared/result.ts';
import { checkCredentials } from './credentials.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';
import { readPassword } from '#domain/accounts/person.ts';
import { startSession, type Where } from './sessions.ts';

export interface SignInInput extends Where {
  readonly username: string;
  readonly password: string;
}

/** Signed in (the session's token, kept for at most `maxAgeDays`), or they must choose a new password first. */
export type SignedIn = { readonly status: 'ok'; readonly token: string; readonly maxAgeDays: number } | { readonly status: 'change' };

/** Sign in with a username and password. */
export class SignIn {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: SignInInput): Promise<Result<SignedIn, AccountError>> {
    const password = readPassword(input.password);
    if (!password.ok) return password;
    const checked = await checkCredentials(this.#deps, input.username, input.password, input.ip);
    if (!checked.ok) return checked;
    if (checked.value.status === 'change') return ok({ status: 'change' });
    const token = await startSession(this.#deps, checked.value.person, input);
    return ok({ status: 'ok', token, maxAgeDays: (await this.#deps.accounts.read()).settings.sessionMaxDays });
  }
}
