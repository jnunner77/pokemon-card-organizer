import type { CardLookup } from '#application/guests/ports.ts';
import type { CardRecord } from '#domain/guests/guest-card.ts';
import type { Store } from './store.ts';

/** One card straight from the store, without reading the rest of the ledger. */
export class StoreCardLookup implements CardLookup {
  readonly #store: Pick<Store, 'get'>;

  constructor(store: Pick<Store, 'get'>) {
    this.#store = store;
  }

  async card(id: string): Promise<CardRecord | undefined> {
    const doc = this.#store.get('cards', id);
    return doc ? { ...doc, id } : undefined;
  }
}
