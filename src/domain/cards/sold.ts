import type { LedgerData } from '../backups/full-backup.ts';
import { isRecord } from '../ledger/document.ts';

// A card that is sold or traded is in no binder, page or pocket: the Sales tab is the only place
// that shows it, and its pocket is free for another card. The place it left is kept as `sale.from`
// so the Selling view and the binder scope still count the sale under the binder it came from.
// Every write path goes through this rule (Card applies it), and so do startup and restores.

type CardFields = Readonly<Record<string, unknown>>;

export const soldOrTraded = (card: CardFields): boolean => card['status'] === 'sold' || card['status'] === 'traded';

const hasPlace = (f: CardFields): boolean => (typeof f['binderId'] === 'string' && f['binderId'] !== '') || (f['page'] ?? null) !== null || (f['slot'] ?? null) !== null;

const numberOrNull = (v: unknown) => (typeof v === 'number' ? v : null);

/** The fields of a sold or traded card with its place cleared (and kept as `sale.from`); other cards as they are. */
export function outOfBinderWhenSold<F extends CardFields>(fields: F): F | (F & { binderId: null; page: null; slot: null; sale: Record<string, unknown> }) {
  if (!soldOrTraded(fields) || !hasPlace(fields)) return fields;
  const binderId = fields['binderId'];
  const from = { binderId: typeof binderId === 'string' && binderId !== '' ? binderId : null, page: numberOrNull(fields['page']), slot: numberOrNull(fields['slot']) };
  const sale = fields['sale'];
  // The pocket it leaves now wins over a from already there (a card set back to In binder keeps its sale).
  const kept = isRecord(sale) ? { ...sale, from } : { from };
  return { ...fields, binderId: null, page: null, slot: null, sale: kept };
}

/** The ledger with every sold or traded card out of its binder, and how many were moved. */
export function withSoldCardsOutOfBinders(ledger: LedgerData): { readonly ledger: LedgerData; readonly moved: number } {
  let moved = 0;
  const cards = Object.fromEntries(
    Object.entries(ledger.cards).map(([id, fields]) => {
      const next = outOfBinderWhenSold(fields);
      if (next !== fields) moved++;
      return [id, next];
    }),
  );
  return { ledger: { ...ledger, cards }, moved };
}
