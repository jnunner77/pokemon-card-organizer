import type { KeptCopy } from '#domain/backups/copies.ts';
import type { LedgerData } from '#domain/backups/full-backup.ts';
import type { Retention } from '#domain/backups/retention.ts';

/** The copies of the ledger kept on the server. */
export interface KeptCopies {
  list(): Promise<readonly KeptCopy[]>;
  /** A copy's text, or null when there is no such copy. */
  read(name: string): Promise<string | null>;
  /** Copy the ledger file as it is on disk; false when there is no ledger file yet. */
  copyLedgerFile(name: string): Promise<boolean>;
  writeLedger(name: string, ledger: LedgerData): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * The ledger as a whole. Replacing it (a restore) happens only through here: the current ledger is
 * kept as a before-restore copy first, and open pages are told to reload everything.
 */
export interface WholeLedger {
  current(): Promise<LedgerData>;
  replace(ledger: LedgerData): Promise<void>;
}

/** The backup settings administrators change (kept outside the ledger, so a restore never changes them). */
export interface BackupSettings {
  retention(): Retention;
  setRetention(retention: Retention): void;
  lastFullBackupAt(): string | null;
  noteFullBackup(at: Date): void;
}
