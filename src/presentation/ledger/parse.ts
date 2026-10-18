import type { ChangePriceEntriesInput } from '#application/ledger/change-price-entries.ts';
import type { PriceEntry } from '#domain/cards/price-entries.ts';
import { MAX_PAGE, MAX_POCKETS } from '#domain/cards/card-fields.ts';
import type { PocketMove } from '#domain/ledger/arrange.ts';
import { isDocumentId } from '#domain/ledger/ids.ts';
import type { Placement } from '#domain/ledger/place.ts';
import { isCount, isRecord, isText, listOf } from '../http/parse.ts';

// The ledger routes' request bodies, checked by hand. Each returns null when the body isn't the
// shape the route takes; the route answers with what to send instead.

const MAX_ENTRIES = 2000;
const MAX_MOVES = 5000;

const priceEntry = (v: unknown): PriceEntry | null => {
  if (!isRecord(v)) return null;
  const id = v['id'];
  return isText(id, 1, 64) ? { ...v, id } : null;
};

/** POST /api/cards/:id/prices: { add?, update?, remove?, fields? } and nothing else. */
export function priceChange(body: unknown): Omit<ChangePriceEntriesInput, 'cardId'> | null {
  if (!isRecord(body)) return null;
  if (Object.keys(body).some((k) => !['add', 'update', 'remove', 'fields'].includes(k))) return null;
  const entries = (v: unknown) => (v === undefined ? undefined : listOf(v, priceEntry, { max: MAX_ENTRIES }));
  const add = entries(body['add']);
  const update = entries(body['update']);
  const remove = body['remove'] === undefined ? undefined : listOf(body['remove'], (id) => (isText(id, 1, 64) ? id : null), { max: MAX_ENTRIES });
  const fields = body['fields'];
  if (add === null || update === null || remove === null || (fields !== undefined && !isRecord(fields))) return null;
  return { add, update, remove, fields };
}

const pocketMove = (v: unknown): PocketMove | null => {
  if (!isRecord(v)) return null;
  const { id, page, slot } = v;
  return isDocumentId(id) && isCount(page, 1, MAX_PAGE) && isCount(slot, 1, MAX_POCKETS) ? { cardId: id, page, slot } : null;
};

/** POST /api/binders/:id/arrange: { moves: [{ id, page, slot }], saveLayout? }. */
export function arrangement(body: unknown): { moves: PocketMove[]; saveLayout: boolean } | null {
  if (!isRecord(body)) return null;
  const moves = listOf(body['moves'], pocketMove, { max: MAX_MOVES });
  const saveLayout = body['saveLayout'];
  if (moves === null || (saveLayout !== undefined && typeof saveLayout !== 'boolean')) return null;
  return { moves, saveLayout: saveLayout === true };
}

/** A card to a binder's page and pocket, or to a display case or nowhere with a blank page and pocket. */
const placement = (v: unknown): Placement | null => {
  if (!isRecord(v)) return null;
  const { id, binderId, page, slot } = v;
  if (!isDocumentId(id)) return null;
  if (isDocumentId(binderId) && isCount(page, 1, MAX_PAGE) && isCount(slot, 1, MAX_POCKETS)) return { cardId: id, binderId, page, slot };
  if ((binderId === null || isDocumentId(binderId)) && page === null && slot === null) return { cardId: id, binderId, page: null, slot: null };
  return null;
};

/** POST /api/cards/place: { moves: [{ id, binderId, page, slot }] }, at least one. */
export function placements(body: unknown): Placement[] | null {
  return isRecord(body) ? listOf(body['moves'], placement, { min: 1, max: MAX_MOVES }) : null;
}
