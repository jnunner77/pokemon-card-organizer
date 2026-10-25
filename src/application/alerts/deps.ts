import type { CardRepository } from '#domain/cards/repository.ts';
import type { AdminSettingsStore, TokenVault } from '../admin/ports.ts';
import type { ConditionRules } from '../guests/ports.ts';
import type { LedgerReader } from '../ledger/ledger-reader.ts';
import type { ServerLog } from '../logging.ts';
import type { Clock, EventPublisher, UnitOfWork } from '../ports.ts';
import type { AlertHistory, Mailer } from './ports.ts';

export interface AlertDeps {
  /** admin.json: where alerts come from and go to. */
  readonly settings: AdminSettingsStore;
  /** The Gmail app password, in a file of its own outside the backed-up data. */
  readonly password: TokenVault;
  readonly mailer: Mailer;
  readonly history: AlertHistory;
  readonly ledger: LedgerReader;
  readonly cards: CardRepository;
  /** The page's condition adjustment, so a card's value is the one the binder shows. */
  readonly condition: ConditionRules;
  readonly unitOfWork: UnitOfWork;
  readonly events: EventPublisher;
  readonly clock: Clock;
  readonly log: ServerLog;
}
