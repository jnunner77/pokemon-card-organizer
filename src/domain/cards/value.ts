import { isRecord } from '../ledger/document.ts';

// A card's value as the page works it out (public/app.js valueOf): its latest market price or sold
// comp, an automatic (near-mint) price adjusted for the card's condition by the page's own rules,
// in CAD.

type CardFields = Readonly<Record<string, unknown>>;
type PriceRecord = Readonly<Record<string, unknown>>;

/** The page's condition adjustment: a near-mint price as the price of a card in this condition. */
export type ConditionAdjust<C extends CardFields = CardFields> = (card: C, price: PriceRecord) => number | null;

const isValuePrice = (p: unknown): p is PriceRecord => isRecord(p) && (p['type'] === 'market' || p['type'] === 'comp') && typeof p['amount'] === 'number';

/** The card's value in CAD, or null when it has no market price or sold comp. */
export function cardValue<C extends CardFields>(card: C, usdToCad: number, adjust: ConditionAdjust<C>): number | null {
  const listed: unknown = card['prices'];
  const prices = (Array.isArray(listed) ? listed.filter(isValuePrice) : []).sort(
    (a, b) => String(b['date'] ?? '').localeCompare(String(a['date'] ?? '')) || String(b['at'] ?? '').localeCompare(String(a['at'] ?? '')),
  );
  const p = prices[0];
  if (!p) return null;
  const amount = adjust(card, p);
  if (amount === null) return null;
  return p['currency'] === 'USD' ? amount * (usdToCad || 1) : amount;
}
