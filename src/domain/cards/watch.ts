import { isRecord } from '../ledger/document.ts';

// Price watches: a price to buy a card at (at or below it) or to sell it at (at or above it), in
// CAD, compared with the card's value as the binder shows it. A card can be watched to buy without
// being in the collection at all: it's on the watchlist (`watchlist`), a placeholder in no binder.
// A watch is emailed once when its card's value reaches it, and again only after the value has
// moved back past it (or its price changed): `watchAlerts` records what was sent.

type CardFields = Readonly<Record<string, unknown>>;

export const WATCH_SIDES = ['buy', 'sell'] as const;
export type WatchSide = (typeof WATCH_SIDES)[number];

/** The prices a card is watched for; null when that side isn't watched. */
export interface WatchTargets {
  readonly buy: number | null;
  readonly sell: number | null;
}

/** A watch that was emailed: when, at what price, and the value that reached it. */
export interface WatchAlertRecord {
  readonly at: string;
  readonly target: number;
  readonly price: number;
}

/** A card's value has reached one of its watches. */
export interface WatchHit {
  readonly side: WatchSide;
  readonly target: number;
  readonly price: number;
}

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export function watchTargets(card: CardFields): WatchTargets {
  const w = card['watch'];
  if (!isRecord(w)) return { buy: null, sell: null };
  return { buy: positive(w['buy']), sell: positive(w['sell']) };
}

/** Only on the watchlist: a card the person doesn't have, in no binder. */
export const onWatchlist = (card: CardFields): boolean => card['watchlist'] === true;

/**
 * A card put in a binder or display case is no longer only on the watchlist (it stays a
 * placeholder, and stays watched): the fields with `watchlist` cleared then, else as they are.
 */
export function offWatchlistWhenPlaced<F extends CardFields>(fields: F): F | (F & { watchlist: false }) {
  const binderId = fields['binderId'];
  return onWatchlist(fields) && typeof binderId === 'string' && binderId !== '' ? { ...fields, watchlist: false } : fields;
}

/** The person has the card: not sold or traded, not a placeholder, not only on the watchlist. */
export const ownsCard = (card: CardFields): boolean => !['sold', 'traded'].includes(String(card['status'] ?? '')) && !card['placeholder'] && !onWatchlist(card);

/**
 * The watches that apply to the card: buying applies to any card (another copy, or one not owned
 * yet), selling only to a card the person has.
 */
export function activeTargets(card: CardFields): WatchTargets {
  const t = watchTargets(card);
  return { buy: t.buy, sell: ownsCard(card) ? t.sell : null };
}

/** Whether the card is watched at all (a buy price, or a sell price on a card the person has). */
export function isWatched(card: CardFields): boolean {
  const t = activeTargets(card);
  return t.buy !== null || t.sell !== null;
}

/** Buying: the value is at or below the price. Selling: at or above it. */
export const reaches = (side: WatchSide, target: number, value: number): boolean => (side === 'buy' ? value <= target : value >= target);

function alertRecord(v: unknown): WatchAlertRecord | null {
  if (!isRecord(v)) return null;
  const { at, target, price } = v;
  return typeof at === 'string' && typeof target === 'number' && typeof price === 'number' ? { at, target, price } : null;
}

/** What was emailed for each of the card's watches. */
export function watchAlerts(card: CardFields): Readonly<Record<WatchSide, WatchAlertRecord | null>> {
  const a = card['watchAlerts'];
  return { buy: alertRecord(isRecord(a) ? a['buy'] : null), sell: alertRecord(isRecord(a) ? a['sell'] : null) };
}

/** The value rounded to the cent, as it's shown and compared. */
const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * The watches the card's value has reached and that haven't been emailed yet for their price. No
 * value (no price logged yet) reaches nothing.
 */
export function dueWatches(card: CardFields, value: number | null): WatchHit[] {
  if (value === null) return [];
  const price = cents(value);
  const targets = activeTargets(card);
  const sent = watchAlerts(card);
  const due: WatchHit[] = [];
  for (const side of WATCH_SIDES) {
    const target = targets[side];
    if (target === null || !reaches(side, target, price)) continue;
    if (sent[side]?.target === target) continue;
    due.push({ side, target, price });
  }
  return due;
}

/**
 * The card's `watchAlerts` after a check that emailed `sent` (the sides whose email went out): a
 * watch emailed now is recorded; a record whose watch is gone, changed price, or is no longer
 * reached is dropped, so it's emailed again when it's next reached. With no value the records
 * stay as they are. Null when nothing changes.
 */
export function alertsAfterCheck(card: CardFields, value: number | null, sent: ReadonlySet<WatchSide>, at: string): { readonly watchAlerts: Readonly<Record<string, WatchAlertRecord>> | null } | null {
  if (value === null) return null;
  const price = cents(value);
  const targets = activeTargets(card);
  const before = watchAlerts(card);
  const next: Record<string, WatchAlertRecord> = {};
  let changed = false;
  for (const side of WATCH_SIDES) {
    const target = targets[side];
    const record = before[side];
    const reached = target !== null && reaches(side, target, price);
    if (record && reached && record.target === target) next[side] = record;
    else if (reached && target !== null && sent.has(side)) {
      next[side] = { at, target, price };
      changed = true;
    } else if (record) changed = true;
  }
  if (!changed) return null;
  return { watchAlerts: Object.keys(next).length ? next : null };
}
