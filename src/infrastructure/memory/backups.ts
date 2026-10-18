import type { BackupSettings, KeptCopies, WholeLedger } from '#application/backups/ports.ts';
import type { LedgerPhotos } from '#application/photos/ports.ts';
import { beforeRestoreName, describeCopy, type KeptCopy } from '#domain/backups/copies.ts';
import type { LedgerData } from '#domain/backups/full-backup.ts';
import { DEFAULT_RETENTION, type Retention } from '#domain/backups/retention.ts';
import { photosReferencedBy } from '#domain/photos/references.ts';

/** Kept copies in memory, for application tests: name → text and when it was written. */
export class MemoryKeptCopies implements KeptCopies {
  readonly files = new Map<string, { text: string; at: Date }>();
  /** The ledger file's text, as copyLedgerFile copies it (null: no ledger file yet). */
  ledgerFile: string | null = null;
  now: () => Date = () => new Date(0);

  async list(): Promise<readonly KeptCopy[]> {
    const out: KeptCopy[] = [];
    for (const [name, f] of this.files) {
      const copy = describeCopy(name, f.at, f.text.length);
      if (copy) out.push(copy);
    }
    return out;
  }

  async read(name: string): Promise<string | null> {
    return this.files.get(name)?.text ?? null;
  }

  async copyLedgerFile(name: string): Promise<boolean> {
    if (this.ledgerFile === null) return false;
    this.files.set(name, { text: this.ledgerFile, at: this.now() });
    return true;
  }

  async writeLedger(name: string, ledger: LedgerData): Promise<void> {
    this.files.set(name, { text: JSON.stringify(ledger), at: this.now() });
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }
}

/** The whole ledger in memory; replacing it keeps a before-restore copy in `copies`, like the store. */
export class MemoryWholeLedger implements WholeLedger, LedgerPhotos {
  data: LedgerData = { binders: {}, cards: {}, settings: {} };
  /** How many times open pages were told to reload everything. */
  resets = 0;
  readonly #copies: MemoryKeptCopies;

  constructor(copies: MemoryKeptCopies) {
    this.#copies = copies;
  }

  async current(): Promise<LedgerData> {
    return structuredClone(this.data);
  }

  async replace(ledger: LedgerData): Promise<void> {
    await this.#copies.writeLedger(beforeRestoreName(this.#copies.now()), this.data);
    this.data = structuredClone(ledger);
    this.resets++;
  }

  async referenced(): Promise<ReadonlySet<string>> {
    return photosReferencedBy(this.data);
  }
}

export class MemoryBackupSettings implements BackupSettings {
  current: Retention = DEFAULT_RETENTION;
  lastFull: string | null = null;

  retention(): Retention {
    return this.current;
  }

  setRetention(retention: Retention): void {
    this.current = retention;
  }

  lastFullBackupAt(): string | null {
    return this.lastFull;
  }

  noteFullBackup(at: Date): void {
    this.lastFull = at.toISOString();
  }
}
