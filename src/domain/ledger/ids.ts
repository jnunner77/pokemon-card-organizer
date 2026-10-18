import { err, ok, type Result } from '#shared/result.ts';

// Every binder, card and setting has an id the page chooses: letters, digits, - and _.

export const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const DOCUMENT_ID_RULE = 'Ids are letters, digits, - and _ (at most 64)';

export type InvalidId = { readonly code: 'INVALID_ID'; readonly id: string };

export const isDocumentId = (value: unknown): value is string => typeof value === 'string' && DOCUMENT_ID.test(value);

export function documentId<T extends string>(raw: string): Result<T, InvalidId> {
  // The one place a checked string becomes a branded id.
  return isDocumentId(raw) ? ok(raw as T) : err({ code: 'INVALID_ID', id: raw });
}
