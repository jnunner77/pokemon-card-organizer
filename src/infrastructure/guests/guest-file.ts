import fs from 'node:fs';
import path from 'node:path';
import type { GuestDesk, GuestState } from '#application/guests/ports.ts';
import { closeOpenVisits, type GuestBook, type GuestSession, type GuestSettings, type GuestVisit } from '#domain/guests/visits.ts';
import type { Result } from '#shared/result.ts';
import { damagedMessage, readJson } from '../json-store/damaged.ts';
import { writePrivate } from '../private-file.ts';

// The guest viewing settings and the guest log in <data>/guests.json (readable only by the
// server), which never reaches the ledger's copies, full backup downloads or API responses other
// than Administration. Signed-in guests are kept in memory only: a restart signs them out.

interface GuestFile {
  settings?: Partial<GuestSettings>;
  log?: GuestVisit[];
}

export interface FileGuestDeskOptions {
  readonly dataDir: string;
  readonly now: () => Date;
  /** A new QR code key, for a server without one yet. */
  readonly newKey: () => string;
  /** A damaged guests.json is set aside and reported: guest viewing starts closed, with a new key and an empty log. */
  readonly onDamaged: (message: string) => void;
}

export class FileGuestDesk implements GuestDesk {
  readonly #file: string;
  #book: GuestBook;
  #sessions: readonly GuestSession[] = [];

  constructor(o: FileGuestDeskOptions) {
    fs.mkdirSync(o.dataDir, { recursive: true });
    this.#file = path.join(o.dataDir, 'guests.json');
    const at = o.now();
    const fresh: GuestSettings = { enabled: false, key: o.newKey(), keyCreatedAt: at.toISOString() };
    const raw = readJson<GuestFile>(this.#file, (d) => o.onDamaged(damagedMessage(d, 'Guest viewing starts closed, with a new QR code, and the guest log starts empty.')));
    this.#book = { settings: { ...fresh, ...raw?.settings }, log: raw?.log ?? [] };
    // Sessions don't survive a restart; close the visits that were open.
    if (!raw || closeOpenVisits(this.#book, at)) this.#save();
  }

  #save(): void {
    writePrivate(this.#file, JSON.stringify(this.#book, null, 2));
  }

  async read(): Promise<{ readonly book: GuestBook; readonly sessions: readonly GuestSession[] }> {
    return { book: { ...this.#book }, sessions: this.#sessions };
  }

  async change<T, E>(work: (state: GuestState) => Result<T, E>): Promise<Result<T, E>> {
    const state: GuestState = { book: { ...this.#book }, sessions: this.#sessions, bookChanged: false };
    const result = work(state);
    if (!result.ok) return result;
    this.#sessions = state.sessions;
    if (state.bookChanged) {
      this.#book = state.book;
      this.#save();
    }
    return result;
  }
}
