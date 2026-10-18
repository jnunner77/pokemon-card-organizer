import { isSessionLive } from '#domain/accounts/session.ts';
import type { AccountDeps } from './deps.ts';

export interface SessionView {
  readonly id: string;
  readonly user: string;
  readonly ip: string;
  readonly agent: string;
  readonly createdAt: string;
  readonly lastSeen: string;
}

/** The browsers signed in now, most recently used first (ended ones are dropped first). */
export class ListSessions {
  readonly #deps: Pick<AccountDeps, 'accounts' | 'sessions' | 'clock'>;

  constructor(deps: Pick<AccountDeps, 'accounts' | 'sessions' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(): Promise<{ readonly sessions: SessionView[] }> {
    const book = await this.#deps.accounts.read();
    const now = this.#deps.clock.now();
    await this.#deps.sessions.remove((s) => !isSessionLive(s, book.settings, now));
    const sessions = (await this.#deps.sessions.list())
      .map((s) => ({ id: s.id, user: book.users.find((u) => u.id === s.userId)?.username ?? '?', ip: s.ip, agent: s.agent, createdAt: new Date(s.createdAt).toISOString(), lastSeen: new Date(s.lastSeen).toISOString() }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    return { sessions };
  }
}
