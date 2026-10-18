import type { LedgerReader, LedgerView } from '#application/ledger/ledger-reader.ts';
import type { Store } from './store.ts';

/** The whole ledger straight from the store, as it is now. */
export class StoreLedgerReader implements LedgerReader {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  async read(): Promise<LedgerView> {
    return this.#store.all();
  }
}
