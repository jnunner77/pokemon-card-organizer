import type { Card, CardPlace } from '#domain/cards/card.ts';
import { type PocketHoldsAnotherCard, pocketKey, pocketRefusal } from '#domain/ledger/pockets.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CardRepository } from '#domain/cards/repository.ts';

/**
 * A card saved into a binder pocket must fit with the cards already there (copies of one card).
 * Only checked when the card is new or its place changed: saves that leave the place alone (a
 * background lookup, a fix from Cards to check, a Table edit) are never refused. `before` is where
 * the card was, or null for a new card.
 */
export async function checkPocket(cards: CardRepository, card: Card, before: CardPlace | null): Promise<Result<void, PocketHoldsAnotherCard>> {
  const key = pocketKey(card.place);
  if (key === null || (before !== null && pocketKey(before) === key)) return ok(undefined);
  const refusal = pocketRefusal(card, await cards.all());
  return refusal ? err(refusal) : ok(undefined);
}
