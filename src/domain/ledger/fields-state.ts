import { type Result } from '#shared/result.ts';
import { checkDocument, type InvalidDocument } from './check-document.ts';
import type { Collection, Fields } from './document.ts';

// How a document's fields change, the same for binders, cards and settings: replaced whole (the
// page saving a document) or merged at the top level (a few fields changed). Either way the
// result is checked as a whole before it is kept.

export function replacedFields(collection: Collection, doc: unknown): Result<Fields, InvalidDocument> {
  return checkDocument(collection, doc);
}

export function mergedFields(collection: Collection, current: Fields, patch: unknown): Result<Fields, InvalidDocument> {
  // Like an object spread, as before: a list adds its items as fields "0", "1", …, and anything
  // that isn't an object or list adds nothing.
  const extra = typeof patch === 'object' && patch !== null ? patch : {};
  return checkDocument(collection, { ...current, ...extra });
}
