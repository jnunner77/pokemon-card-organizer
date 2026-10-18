import type { WholeLedger } from '#application/backups/ports.ts';
import type { LedgerPhotos } from '#application/photos/ports.ts';
import type { LedgerData } from '#domain/backups/full-backup.ts';
import { COLLECTIONS } from '#domain/ledger/document.ts';
import type { Data, Store } from './store.ts';

/** The whole ledger in the JSON store: read it, replace it (a restore), and the photos it refers to. */
export class StoreWholeLedger implements WholeLedger, LedgerPhotos {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  async current(): Promise<LedgerData> {
    return this.#store.raw();
  }

  /** Keeps a before-restore copy first and tells open pages to reload everything (Store.replaceAll). */
  async replace(ledger: LedgerData): Promise<void> {
    const data: Data = { binders: {}, cards: {}, settings: {} };
    for (const c of COLLECTIONS) for (const [id, doc] of Object.entries(ledger[c])) data[c][id] = { ...doc };
    this.#store.replaceAll(data);
  }

  async referenced(): Promise<ReadonlySet<string>> {
    return this.#store.referencedImages();
  }
}
