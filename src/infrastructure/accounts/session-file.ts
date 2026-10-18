import fs from 'node:fs';
import path from 'node:path';
import type { SessionStore } from '#application/accounts/ports.ts';
import type { Session } from '#domain/accounts/session.ts';
import { damagedMessage, readJson } from '../json-store/damaged.ts';
import { writePrivate } from '../private-file.ts';

// Sessions in <data>/sessions.json (readable only by the server), so signing in survives
// restarts. Like auth.json, it never reaches the ledger's copies or full backup downloads.

// Sessions are saved before a change is kept in memory: a write that fails changes nothing, so
// trying again saves it (a signed-out session never comes back after a restart).

export class FileSessionStore implements SessionStore {
  readonly #file: string;
  #sessions = new Map<string, Session>();
  #dirty = false;

  /** A damaged sessions.json is set aside and reported: everyone signs in again. */
  constructor(dataDir: string, onDamaged: (message: string) => void) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.#file = path.join(dataDir, 'sessions.json');
    const saved = readJson<{ sessions?: Session[] }>(this.#file, (d) => onDamaged(damagedMessage(d, 'Everyone needs to sign in again.')));
    for (const s of saved?.sessions ?? []) this.#sessions.set(s.hash, s);
  }

  /** Write these sessions, then keep them. */
  #save(sessions: Map<string, Session>): void {
    writePrivate(this.#file, JSON.stringify({ sessions: [...sessions.values()] }));
    this.#sessions = sessions;
    this.#dirty = false;
  }

  async list(): Promise<readonly Session[]> {
    return [...this.#sessions.values()];
  }

  async find(hash: string): Promise<Session | undefined> {
    return this.#sessions.get(hash);
  }

  async add(session: Session): Promise<void> {
    const next = new Map(this.#sessions);
    next.set(session.hash, session);
    this.#save(next);
  }

  async touch(hash: string, lastSeen: number): Promise<void> {
    const s = this.#sessions.get(hash);
    if (!s) return;
    this.#sessions.set(hash, { ...s, lastSeen });
    this.#dirty = true;
  }

  async remove(which: (session: Session) => boolean): Promise<number> {
    const next = new Map(this.#sessions);
    let n = 0;
    for (const [hash, s] of next) if (which(s) && next.delete(hash)) n++;
    if (n) this.#save(next);
    return n;
  }

  async flush(): Promise<void> {
    if (this.#dirty) this.#save(this.#sessions);
  }
}
