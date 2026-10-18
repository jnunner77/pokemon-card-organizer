import fs from 'node:fs';
import path from 'node:path';
import type { KeptCopies } from '#application/backups/ports.ts';
import { describeCopy, isCopyName, type KeptCopy } from '#domain/backups/copies.ts';
import type { LedgerData } from '#domain/backups/full-backup.ts';

/** The ledger's copies as files in <data>/backups (domain/backups/copies.ts names them). */
export class FileKeptCopies implements KeptCopies {
  readonly #dir: string;
  readonly #ledgerFile: string;

  constructor(dir: string, ledgerFile: string) {
    this.#dir = dir;
    this.#ledgerFile = ledgerFile;
    fs.mkdirSync(dir, { recursive: true });
  }

  async list(): Promise<readonly KeptCopy[]> {
    const out: KeptCopy[] = [];
    for (const name of fs.readdirSync(this.#dir)) {
      if (!isCopyName(name)) continue;
      const st = fs.statSync(path.join(this.#dir, name));
      const copy = describeCopy(name, st.mtime, st.size);
      if (copy) out.push(copy);
    }
    return out;
  }

  async read(name: string): Promise<string | null> {
    const file = this.#file(name);
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }

  async copyLedgerFile(name: string): Promise<boolean> {
    const file = this.#file(name);
    if (!file || !fs.existsSync(this.#ledgerFile)) return false;
    fs.copyFileSync(this.#ledgerFile, file);
    return true;
  }

  async writeLedger(name: string, ledger: LedgerData): Promise<void> {
    const file = this.#file(name);
    if (!file) throw new Error(`${name} isn't a name for a copy of the ledger`);
    fs.writeFileSync(file, JSON.stringify(ledger));
  }

  async remove(name: string): Promise<void> {
    const file = this.#file(name);
    if (file) fs.rmSync(file, { force: true });
  }

  /** The copy's path; only names of copies, so nothing outside the folder is ever reached. */
  #file(name: string): string | null {
    return isCopyName(name) ? path.join(this.#dir, name) : null;
  }
}
