import type { Collection, Fields } from '#domain/ledger/document.ts';
import type { Change, Doc, Store } from './store.ts';

/**
 * One unit of work's view of the ledger: the store as it is while the work runs, with the work's
 * own changes on top. Nothing reaches the store until the session is committed, and if the store
 * changed after the work started (see `startedAt`), the unit of work runs the work again instead.
 */
export class Session {
  readonly #store: Store;
  /** The store's version when the work started; any other change since means it read stale data. */
  readonly startedAt: number;
  readonly #staged = new Map<string, Change>();

  constructor(store: Store) {
    this.#store = store;
    this.startedAt = store.version;
  }

  get(collection: Collection, id: string): Fields | undefined {
    const staged = this.#staged.get(key(collection, id));
    if (staged) return staged.doc ?? undefined;
    return this.#store.get(collection, id);
  }

  all(collection: Collection): { id: string; fields: Fields }[] {
    const out = new Map<string, Fields>(this.#store.entries(collection));
    for (const change of this.#staged.values()) {
      if (change.collection !== collection) continue;
      if (change.doc) out.set(change.id, change.doc);
      else out.delete(change.id);
    }
    return [...out].map(([id, fields]) => ({ id, fields }));
  }

  put(collection: Collection, id: string, fields: Fields): void {
    const doc: Doc = { ...fields };
    this.#stage({ collection, id, doc });
  }

  remove(collection: Collection, id: string): void {
    this.#stage({ collection, id, doc: null });
  }

  /** The changes to save, in the order they were first made; deleting what never existed isn't one. */
  changes(): Change[] {
    return [...this.#staged.values()].filter((c) => c.doc !== null || this.#store.get(c.collection, c.id) !== undefined);
  }

  #stage(change: Change) {
    // A later change to the same document replaces the earlier one but keeps its place in the order.
    this.#staged.set(key(change.collection, change.id), change);
  }
}

const key = (collection: Collection, id: string) => `${collection}/${id}`;
