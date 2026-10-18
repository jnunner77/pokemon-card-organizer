import type { LedgerReader } from '../ledger/ledger-reader.ts';
import type { PhotoStore } from '../photos/ports.ts';
import type { ActivityLog, Base64, Clock, Secrets } from '../ports.ts';
import type { CardLookup, ConditionRules, GuestDesk, QrCodes } from './ports.ts';

export interface GuestDeps {
  readonly desk: GuestDesk;
  readonly ledger: LedgerReader;
  readonly cards: CardLookup;
  readonly photos: Pick<PhotoStore, 'open'>;
  readonly condition: ConditionRules;
  readonly qr: QrCodes;
  readonly secrets: Secrets;
  readonly base64: Base64;
  readonly clock: Clock;
  /** Guests signing in. */
  readonly authLog: ActivityLog;
  /** What administrators change. */
  readonly adminLog: ActivityLog;
}
