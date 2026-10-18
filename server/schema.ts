import { z } from 'zod';
import { DOCUMENT_ID, DOCUMENT_ID_RULE } from '#domain/ledger/ids.ts';

// What the ledger stores now lives in the domain (src/domain/ledger, cards, binders, settings).
// These are the pieces the Express code still uses until its slices move.

export { COLLECTIONS, type Collection, MAX_DOC_BYTES } from '#domain/ledger/document.ts';
export { type Doc, InvalidDoc, validateDoc } from '#infrastructure/json-store/store.ts';

export const idSchema = z.string().regex(DOCUMENT_ID, DOCUMENT_ID_RULE);
