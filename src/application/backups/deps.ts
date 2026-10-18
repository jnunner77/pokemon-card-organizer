import type { LedgerPhotos, PhotoStore } from '../photos/ports.ts';
import type { ActivityLog, Base64, Clock } from '../ports.ts';
import type { BackupSettings, KeptCopies, WholeLedger } from './ports.ts';

export interface BackupDeps {
  readonly photos: PhotoStore;
  readonly ledgerPhotos: LedgerPhotos;
  readonly copies: KeptCopies;
  readonly ledger: WholeLedger;
  readonly settings: BackupSettings;
  readonly clock: Clock;
  readonly base64: Base64;
  /** The backup category of the server log. */
  readonly log: ActivityLog;
  /** The admin category, for settings changes. */
  readonly adminLog: ActivityLog;
}
