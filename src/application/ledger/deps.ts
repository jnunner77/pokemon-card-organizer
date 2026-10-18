import type { BinderRepository } from '#domain/binders/repository.ts';
import type { CardRepository } from '#domain/cards/repository.ts';
import type { SettingRepository } from '#domain/settings/repository.ts';
import type { ActivityLog, Clock, EventPublisher, UnitOfWork } from '../ports.ts';
import type { LedgerReader } from './ledger-reader.ts';

export interface LedgerDeps {
  readonly cards: CardRepository;
  readonly binders: BinderRepository;
  readonly settings: SettingRepository;
  readonly reader: LedgerReader;
  readonly clock: Clock;
  readonly events: EventPublisher;
  readonly unitOfWork: UnitOfWork;
  readonly activity: ActivityLog;
}
