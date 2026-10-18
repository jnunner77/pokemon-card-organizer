import type { AccountDeps } from './deps.ts';
import { endSessionsOf } from './sessions.ts';

/** Sign someone out of every browser. */
export class SignPersonOut {
  readonly #deps: Pick<AccountDeps, 'sessions' | 'adminLog'>;

  constructor(deps: Pick<AccountDeps, 'sessions' | 'adminLog'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly id: string }): Promise<{ readonly signedOut: number }> {
    const n = await endSessionsOf(this.#deps, input.id);
    this.#deps.adminLog.info(`${input.actor} signed a person out of ${n} session${n === 1 ? '' : 's'}`);
    return { signedOut: n };
  }
}
