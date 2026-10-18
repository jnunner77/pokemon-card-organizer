import { err, ok, type Result } from '#shared/result.ts';
import type { Binder } from '../binders/binder.ts';
import type { Card, CardPlace } from '../cards/card.ts';
import type { InvalidDocument } from './check-document.ts';

// Moving cards to another binder (or anywhere): each card goes to the binder, page and pocket
// given, all together. The pockets they leave stay empty. Refused if a card would land in a
// pocket another card is in afterwards (one added or moved meanwhile). A display case has no
// pockets: cards go in it with a blank page and pocket.

export interface Placement extends CardPlace {
  readonly cardId: string;
}

export type PlaceError =
  | { readonly code: 'CARD_GIVEN_TWICE' }
  | { readonly code: 'CARD_DELETED_MEANWHILE' }
  | { readonly code: 'BINDER_GONE' }
  | { readonly code: 'CASE_HAS_NO_POCKETS'; readonly binderName: string | null }
  | { readonly code: 'POCKET_REQUIRED' }
  | { readonly code: 'POCKET_PAST_PAGE' }
  | { readonly code: 'POCKET_TAKEN' }
  | InvalidDocument;

const pocketKey = (p: CardPlace) => `${p.binderId}/${p.page}/${p.slot}`;

/** Move every card at once; the cards that changed place. */
export function placeCards(placements: readonly Placement[], cards: readonly Card[], binders: readonly Binder[], at: Date): Result<readonly Card[], PlaceError> {
  if (new Set(placements.map((p) => p.cardId)).size !== placements.length) return err({ code: 'CARD_GIVEN_TWICE' });
  const cardById = new Map(cards.map((c) => [String(c.id), c]));
  if (placements.some((p) => !cardById.has(p.cardId))) return err({ code: 'CARD_DELETED_MEANWHILE' });
  const binderById = new Map(binders.map((b) => [String(b.id), b]));
  for (const p of placements) {
    if (p.binderId === null) continue;
    const binder = binderById.get(p.binderId);
    if (!binder) return err({ code: 'BINDER_GONE' });
    if (binder.isCase) {
      if (p.page !== null) return err({ code: 'CASE_HAS_NO_POCKETS', binderName: binder.name });
      continue;
    }
    if (p.page === null || p.slot === null) return err({ code: 'POCKET_REQUIRED' });
    if (p.slot > binder.pocketsPerPage) return err({ code: 'POCKET_PAST_PAGE' });
  }
  // Each card lands in a pocket no other card is in once this is done (the ones moving away free theirs).
  const moving = new Set(placements.map((p) => p.cardId));
  const taken = new Set(cards.filter((c) => !moving.has(c.id)).map((c) => pocketKey(c.place)));
  for (const p of placements) {
    if (p.binderId === null || p.page === null) continue;
    if (taken.has(pocketKey(p))) return err({ code: 'POCKET_TAKEN' });
    taken.add(pocketKey(p));
  }
  const moved: Card[] = [];
  for (const p of placements) {
    const card = cardById.get(p.cardId);
    if (!card) return err({ code: 'CARD_DELETED_MEANWHILE' });
    const r = card.moveTo({ binderId: p.binderId, page: p.page, slot: p.slot }, at);
    if (!r.ok) return r;
    if (r.value) moved.push(card);
  }
  return ok(moved);
}
