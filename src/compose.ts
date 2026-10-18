// Composition root: the only code that knows the concrete classes and wires them together.
// main.ts starts the server with it; tests build apps with it.

import type { ActivityLog } from '#application/ports.ts';
import { ArrangeBinder } from '#application/ledger/arrange-binder.ts';
import { ChangePriceEntries } from '#application/ledger/change-price-entries.ts';
import { DeleteDocument } from '#application/ledger/delete-document.ts';
import type { LedgerDeps } from '#application/ledger/deps.ts';
import { MergeDocument } from '#application/ledger/merge-document.ts';
import { PlaceCards } from '#application/ledger/place-cards.ts';
import { PutDocument } from '#application/ledger/put-document.ts';
import { ReadLedger } from '#application/ledger/read-ledger.ts';
import { StoreLedgerReader } from '#infrastructure/json-store/ledger-reader.ts';
import { JsonBinderRepository, JsonCardRepository, JsonSettingRepository } from '#infrastructure/json-store/repositories.ts';
import type { Store } from '#infrastructure/json-store/store.ts';
import { StoreUnitOfWork } from '#infrastructure/json-store/unit-of-work.ts';
import { LocalEventBus } from '#infrastructure/local-event-bus.ts';
import { SystemClock } from '#infrastructure/system-clock.ts';
import type { CallerResolver } from '#presentation/http/caller.ts';
import type { Router } from '#presentation/http/router.ts';
import { ledgerRoutes } from '#presentation/ledger/routes.ts';
import { type AppOptions, createExpressApp } from '../server/app.ts';

export interface CreateAppOptions extends Omit<AppOptions, 'layeredRoutes'> {
  /** Where published domain events go; a private bus if omitted. */
  readonly events?: LocalEventBus | undefined;
}

/** The ledger slice over the JSON store, as HTTP routes relative to /api. */
export function composeLedgerRoutes(store: Store, identify: CallerResolver, activity: ActivityLog, events: LocalEventBus): Router {
  const unitOfWork = new StoreUnitOfWork(store);
  const deps: LedgerDeps = {
    cards: new JsonCardRepository(unitOfWork),
    binders: new JsonBinderRepository(unitOfWork),
    settings: new JsonSettingRepository(unitOfWork),
    reader: new StoreLedgerReader(store),
    clock: new SystemClock(),
    events,
    unitOfWork,
    activity,
  };
  return ledgerRoutes({
    identify,
    readLedger: new ReadLedger(deps),
    putDocument: new PutDocument(deps),
    mergeDocument: new MergeDocument(deps),
    deleteDocument: new DeleteDocument(deps),
    changePriceEntries: new ChangePriceEntries(deps),
    arrangeBinder: new ArrangeBinder(deps),
    placeCards: new PlaceCards(deps),
  });
}

/** The whole app: the layered slices plugged into the Express server that still hosts the rest. */
export function createApp(options: CreateAppOptions) {
  const { events = new LocalEventBus(), ...rest } = options;
  return createExpressApp({ ...rest, layeredRoutes: ({ identify, activity }) => composeLedgerRoutes(options.store, identify, activity, events) });
}
