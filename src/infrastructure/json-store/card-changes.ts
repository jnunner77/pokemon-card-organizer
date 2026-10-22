import type { CardChange, CardChanges } from '#application/catalog/ports.ts';
import type { Fields } from '#domain/ledger/document.ts';
import type { Store } from './store.ts';

/** The store's cards as they change: each card saved or deleted, and whole-ledger replacements. */
export class StoreCardChanges implements CardChanges {
  readonly #store: Pick<Store, 'subscribe' | 'entries'>;

  constructor(store: Pick<Store, 'subscribe' | 'entries'>) {
    this.#store = store;
  }

  current(): readonly { readonly id: string; readonly card: Fields }[] {
    return this.#store.entries('cards').map(([id, card]) => ({ id, card }));
  }

  subscribe(listener: (change: CardChange) => void): () => void {
    return this.#store.subscribe((e) => {
      if (e.type === 'reset') return listener({ kind: 'replaced' });
      if (e.change.collection === 'cards') listener({ kind: 'card', id: e.change.id, card: e.change.doc });
    });
  }
}
