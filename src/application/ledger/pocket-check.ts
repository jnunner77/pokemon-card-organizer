import type { Card, CardPlace } from '#domain/cards/card.ts';
import type { BinderId } from '#domain/binders/binder.ts';
import type { BinderRepository } from '#domain/binders/repository.ts';
import { documentId } from '#domain/ledger/ids.ts';
import { type BinderGone, binderEntered, type PocketHoldsAnotherCard, pocketKey, pocketRefusal } from '#domain/ledger/pockets.ts';
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

/**
 * A card can only be put in a binder that exists. Checked only when the card is put in a binder
 * (new with one, or moved to another): a card already pointing at a missing binder can still be
 * edited, moved elsewhere or taken out of every binder. `before` is where the card was, or null for a new card.
 */
export async function checkBinder(binders: BinderRepository, card: Card, before: CardPlace | null): Promise<Result<void, BinderGone>> {
  const entered = binderEntered(card, before);
  if (entered === null) return ok(undefined);
  const id = documentId<BinderId>(entered);
  if (!id.ok || !(await binders.findById(id.value))) return err({ code: 'BINDER_GONE' });
  return ok(undefined);
}
