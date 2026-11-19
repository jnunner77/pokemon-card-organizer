import type { BinderRepository } from '#domain/binders/repository.ts';
import type { CardRepository } from '#domain/cards/repository.ts';
import type { SettingRepository } from '#domain/settings/repository.ts';
import type { ActivityLog, Clock, EventPublisher, IdGenerator, UnitOfWork } from '../ports.ts';
import type { JapaneseCatalog } from './japanese-catalog.ts';
import type { AnyCardPricing, CardChanges, CardDatabase, CardPricing, JapaneseIndexStore, JobLog, Scheduler, TcgplayerCatalog } from './ports.ts';

export interface CatalogDeps {
  readonly database: CardDatabase;
  /** Null on a server that doesn't use TCGplayer's catalog. */
  readonly tcgplayer: TcgplayerCatalog | null;
  /** Null on a server without automatic prices. */
  readonly pricing: CardPricing | null;
  readonly anyCardPricing: AnyCardPricing;
  /** TCGplayer's Japanese catalog, its index and TCGdex's Japanese cards; null: no Japanese lookups on this server. */
  readonly japanese: {
    readonly tcgplayer: TcgplayerCatalog;
    readonly database: CardDatabase;
    readonly catalog: JapaneseCatalog;
    readonly store: JapaneseIndexStore;
  } | null;
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
