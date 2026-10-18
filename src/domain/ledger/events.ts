import type { Collection } from './document.ts';

/** A binder, card or setting was created or changed, or deleted. */
export type LedgerEvent =
  | { readonly type: 'DocumentSaved'; readonly collection: Collection; readonly id: string; readonly occurredAt: Date }
  | { readonly type: 'DocumentDeleted'; readonly collection: Collection; readonly id: string; readonly occurredAt: Date };
