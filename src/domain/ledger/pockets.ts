import type { Card, CardPlace } from '../cards/card.ts';
import { sameCard } from '../cards/identity.ts';

// A binder pocket holds copies of one card: several cards may share a pocket only when they are the
// same card (see cards/identity.ts). Display cases and loose cards have no pockets.

export interface PocketHoldsAnotherCard {
  readonly code: 'POCKET_HOLDS_ANOTHER_CARD';
  /** The name of the card already in the pocket. */
  readonly name: string | null;
}

/** The binder a card is saved into does not exist. */
export interface BinderGone {
  readonly code: 'BINDER_GONE';
}

/** The binder a card is being put in: new with a binder, or moved to another one; null otherwise (kept, or out of every binder). */
export function binderEntered(card: Card, before: CardPlace | null): string | null {
  const to = card.place.binderId;
  return to !== null && (before === null || before.binderId !== to) ? to : null;
}

/** The pocket a place is, or null for a case or no binder. */
export const pocketKey = (p: CardPlace): string | null => (p.binderId === null || p.page === null || p.slot === null ? null : `${p.binderId}/${p.page}/${p.slot}`);

const nameOf = (c: Card): string | null => (typeof c.fields['name'] === 'string' ? c.fields['name'] : null);

/** The refusal when another card in the card's pocket is a different card; null when it fits. */
export function pocketRefusal(card: Card, cards: readonly Card[]): PocketHoldsAnotherCard | null {
  const key = pocketKey(card.place);
  if (key === null) return null;
  const other = cards.find((c) => c.id !== card.id && pocketKey(c.place) === key && !sameCard(c.fields, card.fields));
  return other ? { code: 'POCKET_HOLDS_ANOTHER_CARD', name: nameOf(other) } : null;
}
