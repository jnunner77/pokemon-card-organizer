import type { AccountDeps } from './deps.ts';

/** End one signed-in browser's session. */
export class EndSession {
  readonly #deps: Pick<AccountDeps, 'sessions' | 'adminLog'>;

  constructor(deps: Pick<AccountDeps, 'sessions' | 'adminLog'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly id: string }): Promise<void> {
    await this.#deps.sessions.remove((s) => s.id === input.id);
    this.#deps.adminLog.info(`${input.actor} ended a session`);
  }
}
