import type { AccountDeps } from './deps.ts';

/** Save sessions' last-seen times (once a minute, and when the server stops) rather than on every request. */
export class FlushSessions {
  readonly #deps: Pick<AccountDeps, 'sessions'>;

  constructor(deps: Pick<AccountDeps, 'sessions'>) {
    this.#deps = deps;
  }

  execute(): Promise<void> {
    return this.#deps.sessions.flush();
  }
}
