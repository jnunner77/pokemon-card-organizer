import { err, ok, type Result } from '#shared/result.ts';
import { BINDER_FIELDS } from '../binders/binder-fields.ts';
import { CARD_FIELDS } from '../cards/card-fields.ts';
import { SETTING_FIELDS } from '../settings/setting-fields.ts';
import { type Collection, type Fields, isRecord, MAX_DOC_BYTES } from './document.ts';
import { checkLoose, type Shape } from './rules.ts';

export type InvalidDocument = { readonly code: 'INVALID_DOCUMENT'; readonly message: string };

const SHAPES: Readonly<Record<Collection, Shape>> = { binders: BINDER_FIELDS, cards: CARD_FIELDS, settings: SETTING_FIELDS };

/**
 * Check a binder, card or setting about to be saved: an object, not too large, its known fields
 * valid. Returns its fields without the id (the id is the document's address, not a field).
 */
export function checkDocument(collection: Collection, doc: unknown): Result<Fields, InvalidDocument> {
  if (!isRecord(doc)) return err({ code: 'INVALID_DOCUMENT', message: 'A document must be a JSON object' });
  const { id: _id, ...fields } = doc;
  if (JSON.stringify(fields).length > MAX_DOC_BYTES) return err({ code: 'INVALID_DOCUMENT', message: 'That document is too large' });
  const r = checkLoose(fields, SHAPES[collection]);
  if (!r.ok) return err({ code: 'INVALID_DOCUMENT', message: `${r.error.path || collection}: ${r.error.message}` });
  return ok(r.value);
}
