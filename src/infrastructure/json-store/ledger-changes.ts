import type { LedgerChange, LedgerChanges } from '#application/guests/ports.ts';
import type { Store } from './store.ts';

/** The store's change feed: each document saved or deleted, and whole-ledger replacements. */
export class StoreLedgerChanges implements LedgerChanges {
  readonly #store: Pick<Store, 'subscribe'>;

  constructor(store: Pick<Store, 'subscribe'>) {
    this.#store = store;
  }

  subscribe(listener: (change: LedgerChange) => void): () => void {
    return this.#store.subscribe((e) => listener({ collection: e.type === 'change' ? e.change.collection : null }));
  }
}
