import fs from 'node:fs';
import path from 'node:path';
import type { TokenVault } from '#application/admin/ports.ts';
import type { TokenState } from '#domain/admin/pricecharting-token.ts';
import { writePrivate } from '../private-file.ts';

// A secret the server keeps for an outside service (PriceCharting's API token), one per file in
// its own directory: SECRETS_DIR, which in Docker is a volume of its own, so the ledger's backups
// (db.json and pictures), the data volume's archives and exports never contain it. Only the
// server reads it; nothing shows, logs or returns its value, only whether one is saved and when.

export class FileSecret implements TokenVault {
  readonly #file: string;

  constructor(dir: string, name: string) {
    this.#file = path.join(dir, name);
  }

  /** The value, or null when none is saved (or it can't be read). */
  read(): string | null {
    try {
      const v = fs.readFileSync(this.#file, 'utf8').trim();
      return v || null;
    } catch {
      return null;
    }
  }

  /** Whether one is saved, and when it was saved. */
  info(): TokenState {
    try {
      const st = fs.statSync(this.#file);
      return { set: st.size > 0, savedAt: st.mtime.toISOString() };
    } catch {
      return { set: false, savedAt: null };
    }
  }

  write(value: string): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    writePrivate(this.#file, value.trim() + '\n');
  }

  clear(): void {
    fs.rmSync(this.#file, { force: true });
  }
}
