import type { BinderRepository } from '#domain/binders/repository.ts';
import type { CardRepository } from '#domain/cards/repository.ts';
import type { SettingRepository } from '#domain/settings/repository.ts';
import type { ActivityLog, Clock, EventPublisher, IdGenerator, UnitOfWork } from '../ports.ts';
import type { AnyCardPricing, CardChanges, CardDatabase, CardPricing, JobLog, Scheduler, TcgplayerCatalog } from './ports.ts';

export interface CatalogDeps {
  readonly database: CardDatabase;
  /** Null on a server that doesn't use TCGplayer's catalog. */
  readonly tcgplayer: TcgplayerCatalog | null;
  /** Null on a server without automatic prices. */
  readonly pricing: CardPricing | null;
  readonly anyCardPricing: AnyCardPricing;
  readonly cards: CardRepository;
  readonly binders: BinderRepository;
  readonly settings: SettingRepository;
  readonly changes: CardChanges;
  readonly unitOfWork: UnitOfWork;
  readonly events: EventPublisher;
  readonly clock: Clock;
  /** New binders' and cards' ids. */
  readonly ids: IdGenerator;
  readonly scheduler: Scheduler;
  /** Looking cards up and filling them in (the server log's pricing lines). */
  readonly log: JobLog;
  /** Who did what (the server log's app lines): master sets made. */
  readonly activity: ActivityLog;
  /** Pause between cards filled in one after another, so a big import doesn't hammer the sites. */
  readonly delayMs: number;
}
