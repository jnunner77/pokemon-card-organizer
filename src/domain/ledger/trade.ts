import { err, ok, type Result } from '#shared/result.ts';
import type { Binder } from '../binders/binder.ts';
import { Card, type CardId, type CardPlace } from '../cards/card.ts';
import type { PriceEntry, PriceEntryError } from '../cards/price-entries.ts';
import type { InvalidDocument } from './check-document.ts';
import { type Fields, isRecord } from './document.ts';
import { documentId, type InvalidId } from './ids.ts';

// A trade with a dealer, recorded all at once: the cards I give are traded away (out of their
// binders, with a sale record of what they went for), and the cards I get come in, each as a new
// card where I chose (a binder's next free pocket, a display case, or no binder) or filling a
// placeholder of mine. Every card it touches carries the trade's id, so it can be undone: my cards
// go back where they were, the added cards go, and the filled placeholders hold their pockets again.
// The amounts (each card's share) are worked out by the page; these are the rules for the cards.

/** A card of mine traded away: its sale record and the price entry of what it went for. */
export interface GivenCard {
  readonly cardId: string;
  readonly sale: Fields;
  readonly entry: PriceEntry;
}

/** A card I get: a new card (its details, where it goes) or one of my placeholders filled. */
export type ReceivedCard =
  | { readonly kind: 'new'; readonly cardId: string; readonly doc: Fields; readonly binderId: string | null; readonly entries: readonly PriceEntry[] }
  | { readonly kind: 'placeholder'; readonly cardId: string; readonly grader: string; readonly grade: string; readonly entries: readonly PriceEntry[] };

export interface TradeRecord {
  readonly tradeId: string;
  /** What the trade was (its date, the cash each way, how many cards, who with), kept on every card it touches. */
  readonly summary: Fields;
  readonly given: readonly GivenCard[];
  readonly received: readonly ReceivedCard[];
}

export type TradeError =
  | { readonly code: 'NOTHING_TO_RECORD' }
  | { readonly code: 'CARD_GIVEN_TWICE' }
  | { readonly code: 'CARD_DELETED_MEANWHILE' }
  | { readonly code: 'CARD_NOT_HELD'; readonly name: string | null }
  | { readonly code: 'NOT_A_PLACEHOLDER'; readonly name: string | null }
  | { readonly code: 'CARD_ID_TAKEN' }
  | { readonly code: 'BINDER_GONE' }
  | { readonly code: 'TRADE_NOT_FOUND' }
  | { readonly code: 'TRADED_CARD_GONE_ON'; readonly name: string | null }
  | InvalidId
  | InvalidDocument
  | PriceEntryError;

/** What recording or undoing a trade changed: the cards to save and the ones to delete. */
export interface TradeChange {
  readonly saved: readonly Card[];
  readonly deleted: readonly Card[];
}

const nameOf = (c: Card) => (typeof c.fields['name'] === 'string' ? c.fields['name'] : null);
const held = (c: Card) => c.fields['status'] !== 'sold' && c.fields['status'] !== 'traded';
const isPlaceholder = (c: Card) => c.fields['placeholder'] === true;
const tradeOf = (v: unknown) => (isRecord(v) && typeof v['id'] === 'string' ? v : null);
const pocketKey = (binderId: string, page: number, slot: number) => `${binderId}/${page}/${slot}`;

/** The pockets cards are in, and each binder's last page with a card on it. */
class Pockets {
  readonly #taken = new Set<string>();
  readonly #lastPage = new Map<string, number>();

  constructor(cards: readonly Card[]) {
    for (const c of cards) this.take(c.place);
  }

  take(p: CardPlace): void {
    if (p.binderId === null || p.page === null || p.slot === null) return;
    this.#taken.add(pocketKey(p.binderId, p.page, p.slot));
    this.#lastPage.set(p.binderId, Math.max(this.#lastPage.get(p.binderId) ?? 0, p.page));
  }

  free(binderId: string, page: number, slot: number): boolean {
    return !this.#taken.has(pocketKey(binderId, page, slot));
  }

  /** The binder's first empty pocket (a case has none: no page or pocket), taken. */
  next(binder: Binder): CardPlace {
    const id = String(binder.id);
    if (binder.isCase) return { binderId: id, page: null, slot: null };
    const last = this.#lastPage.get(id) ?? 0;
    for (let page = 1; page <= last + 1; page++) {
      for (let slot = 1; slot <= binder.pocketsPerPage; slot++) {
        if (this.free(id, page, slot)) {
          const place = { binderId: id, page, slot };
          this.take(place);
          return place;
        }
      }
    }
    const place = { binderId: id, page: last + 1, slot: 1 };
    this.take(place);
    return place;
  }
}

/** Record the trade: every card it touches, changed, or the first reason it can't be (nothing changed). */
export function recordTrade(t: TradeRecord, cards: readonly Card[], binders: readonly Binder[], at: Date): Result<TradeChange, TradeError> {
  if (!t.given.length && !t.received.length) return err({ code: 'NOTHING_TO_RECORD' });
  const ids = [...t.given.map((g) => g.cardId), ...t.received.map((r) => r.cardId)];
  if (new Set(ids).size !== ids.length) return err({ code: 'CARD_GIVEN_TWICE' });
  const cardById = new Map(cards.map((c) => [String(c.id), c]));
  const binderById = new Map(binders.map((b) => [String(b.id), b]));

  // Everything is checked before any card changes.
  for (const g of t.given) {
    const card = cardById.get(g.cardId);
    if (!card) return err({ code: 'CARD_DELETED_MEANWHILE' });
    if (!held(card) || isPlaceholder(card)) return err({ code: 'CARD_NOT_HELD', name: nameOf(card) });
  }
  for (const r of t.received) {
    if (r.kind === 'placeholder') {
      const card = cardById.get(r.cardId);
      if (!card) return err({ code: 'CARD_DELETED_MEANWHILE' });
      if (!held(card) || !isPlaceholder(card)) return err({ code: 'NOT_A_PLACEHOLDER', name: nameOf(card) });
    } else {
      const id = documentId<CardId>(r.cardId);
      if (!id.ok) return id;
      if (cardById.has(r.cardId)) return err({ code: 'CARD_ID_TAKEN' });
      if (r.binderId !== null && !binderById.has(r.binderId)) return err({ code: 'BINDER_GONE' });
    }
  }

  const stamp = at.toISOString();
  const saved: Card[] = [];
  // The new cards go in pockets nobody was in: the ones my traded cards leave stay empty.
  const pockets = new Pockets(cards);
  for (const r of t.received) {
    if (r.kind === 'placeholder') continue;
    const id = documentId<CardId>(r.cardId);
    if (!id.ok) return id;
    const binder = r.binderId === null ? undefined : binderById.get(r.binderId);
    const place: CardPlace = binder ? pockets.next(binder) : { binderId: null, page: null, slot: null };
    const { id: _id, prices: _prices, trade: _trade, sale: _sale, ...doc } = r.doc;
    const made = Card.create(id.value, { ...doc, ...place, status: 'binder', placeholder: false, prices: r.entries, trade: { ...t.summary, id: t.tradeId, filled: false }, createdAt: stamp, updatedAt: stamp }, at);
    if (!made.ok) return made;
    saved.push(made.value);
  }
  for (const r of t.received) {
    const card = r.kind === 'placeholder' ? cardById.get(r.cardId) : undefined;
    if (r.kind !== 'placeholder' || !card) continue;
    const was = { grader: card.fields['grader'] ?? null, grade: card.fields['grade'] ?? null };
    const trade = { ...t.summary, id: t.tradeId, filled: true, was, entryIds: r.entries.map((e) => e.id) };
    const done = card.changePriceEntries({ add: r.entries, fields: { placeholder: false, grader: r.grader, grade: r.grade, trade, updatedAt: stamp } }, at);
    if (!done.ok) return done;
    saved.push(card);
  }
  for (const g of t.given) {
    const card = cardById.get(g.cardId);
    if (!card) return err({ code: 'CARD_DELETED_MEANWHILE' });
    const sale = { ...g.sale, priceId: g.entry.id, from: card.place, trade: { ...t.summary, id: t.tradeId } };
    const r = card.changePriceEntries({ add: [g.entry], fields: { status: 'traded', binderId: null, page: null, slot: null, sale, updatedAt: stamp } }, at);
    if (!r.ok) return r;
    saved.push(card);
  }
  return ok({ saved, deleted: [] });
}

/**
 * Undo a recorded trade: my traded cards come back to the pockets they left (or the next free one
 * in that binder, or no binder when it's gone), the cards added by it are deleted, and the
 * placeholders it filled hold their pockets again, as they were.
 */
export function undoTrade(tradeId: string, cards: readonly Card[], binders: readonly Binder[], at: Date): Result<TradeChange, TradeError> {
  const stamp = at.toISOString();
  const binderById = new Map(binders.map((b) => [String(b.id), b]));
  const given = cards.filter((c) => isRecord(c.fields['sale']) && tradeOf(c.fields['sale']['trade'])?.['id'] === tradeId);
  const received = cards.filter((c) => tradeOf(c.fields['trade'])?.['id'] === tradeId);
  if (!given.length && !received.length) return err({ code: 'TRADE_NOT_FOUND' });

  // A card I got and have sold or traded on since can't be taken back: nothing is undone.
  const goneOn = received.find((c) => !held(c));
  if (goneOn) return err({ code: 'TRADED_CARD_GONE_ON', name: nameOf(goneOn) });

  const deleted = received.filter((c) => tradeOf(c.fields['trade'])?.['filled'] !== true);
  const going = new Set(deleted.map((c) => String(c.id)));
  const pockets = new Pockets(cards.filter((c) => !going.has(String(c.id))));
  const saved: Card[] = [];

  for (const card of received) {
    if (going.has(String(card.id))) continue;
    const trade = tradeOf(card.fields['trade']);
    const was = isRecord(trade?.['was']) ? trade['was'] : {};
    const entryIds = Array.isArray(trade?.['entryIds']) ? trade['entryIds'].filter((x): x is string => typeof x === 'string') : [];
    const r = card.changePriceEntries({ remove: entryIds, fields: { placeholder: true, grader: was['grader'] ?? null, grade: was['grade'] ?? null, trade: null, updatedAt: stamp } }, at);
    if (!r.ok) return r;
    saved.push(card);
  }

  for (const card of given) {
    const sale = isRecord(card.fields['sale']) ? card.fields['sale'] : {};
    const from = isRecord(sale['from']) ? sale['from'] : {};
    const binder = typeof from['binderId'] === 'string' ? binderById.get(from['binderId']) : undefined;
    let place: CardPlace = { binderId: null, page: null, slot: null };
    if (binder) {
      const { page, slot } = from;
      if (!binder.isCase && binder.fits(page, slot) && typeof page === 'number' && typeof slot === 'number' && pockets.free(String(binder.id), page, slot)) {
        place = { binderId: String(binder.id), page, slot };
        pockets.take(place);
      } else place = pockets.next(binder);
    }
    const priceId = typeof sale['priceId'] === 'string' ? [sale['priceId']] : [];
    const r = card.changePriceEntries({ remove: priceId, fields: { ...place, status: 'binder', sale: null, updatedAt: stamp } }, at);
    if (!r.ok) return r;
    saved.push(card);
  }

  for (const card of deleted) card.delete(at);
  return ok({ saved, deleted });
}
