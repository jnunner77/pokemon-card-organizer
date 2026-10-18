import { err, ok, type Result } from '#shared/result.ts';
import { type Fields, isRecord } from '../ledger/document.ts';

// A card's price entries changed one by one, against the list the card has now, instead of the
// page sending the whole list from its own copy. So an entry the daily update (or another person)
// added since the page last heard about the card isn't lost.

export type PriceEntry = Fields & { readonly id: string };

export interface PriceEntryChange {
  /** New entries, appended (one whose id is already there is left as it is). */
  readonly add?: readonly PriceEntry[] | undefined;
  /** Whole entries that replace the ones with their id. */
  readonly update?: readonly PriceEntry[] | undefined;
  /** Ids of entries to take out (one already gone is fine). */
  readonly remove?: readonly string[] | undefined;
  /** Other fields that change with them (a sale's status and location). */
  readonly fields?: Fields | undefined;
}

export type PriceEntryError = { readonly code: 'PRICES_SENT_AS_FIELDS' } | { readonly code: 'PRICE_ENTRY_GONE' };

/** The entries are sent as add, update and remove, never as plain fields (nor the card's id). */
export function checkPriceEntryFields(fields: Fields | undefined): Result<void, PriceEntryError> {
  return fields && ('prices' in fields || 'id' in fields) ? err({ code: 'PRICES_SENT_AS_FIELDS' }) : ok(undefined);
}

const idOf = (entry: unknown) => (isRecord(entry) ? entry['id'] : undefined);

/** The card's price list with the change applied. */
export function applyPriceEntries(list: unknown, change: PriceEntryChange): Result<unknown[], PriceEntryError> {
  const remove = new Set(change.remove ?? []);
  const out: unknown[] = (Array.isArray(list) ? list : []).filter((e) => !remove.has(String(idOf(e))));
  for (const u of change.update ?? []) {
    const i = out.findIndex((e) => idOf(e) === u.id);
    // Changing an entry that was removed meanwhile would bring it back.
    if (i < 0) return err({ code: 'PRICE_ENTRY_GONE' });
    out[i] = u;
  }
  for (const a of change.add ?? []) if (!out.some((e) => idOf(e) === a.id)) out.push(a);
  return ok(out);
}
