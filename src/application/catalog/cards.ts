import type { Card, CardId } from '#domain/cards/card.ts';
import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import type { Fields } from '#domain/ledger/document.ts';
import { documentId } from '#domain/ledger/ids.ts';
import { ok, type Result } from '#shared/result.ts';
import { commit } from '../ledger/commit.ts';
import type { CatalogDeps } from './deps.ts';

// Reading and changing one card around a lookup. The lookup itself (the card database's answers)
// happens between the two, outside any unit of work, so saving other changes never waits for it.

type Deps = Pick<CatalogDeps, 'cards' | 'unitOfWork' | 'events'>;

/** A card's fields as they are now, or undefined when there is no such card. */
export async function readCard(deps: Deps, id: string): Promise<Fields | undefined> {
  const cardId = documentId<CardId>(id);
  if (!cardId.ok) return undefined;
  const value = cardId.value;
  const read = await deps.unitOfWork.run(async () => ok((await deps.cards.findById(value))?.fields));
  return read.ok ? read.value : undefined;
}

/** Every card as it is now. */
export async function readCards(deps: Deps): Promise<readonly { readonly id: string; readonly fields: Fields }[]> {
  const read = await deps.unitOfWork.run(async () => ok((await deps.cards.all()).map((c) => ({ id: String(c.id), fields: c.fields }))));
  return read.ok ? read.value : [];
}

/**
 * Change a card as it is now, as one unit of work; undefined when it no longer exists. A change
 * the card refuses (a field too long, say) is a bug in what changes it, so it's thrown.
 */
export async function changeCard<T>(deps: Deps, id: string, change: (card: Card) => Result<T, InvalidDocument>): Promise<T | undefined> {
  const cardId = documentId<CardId>(id);
  if (!cardId.ok) return undefined;
  const value = cardId.value;
  const done = await commit<T | undefined, InvalidDocument>(deps, async () => {
    const card = await deps.cards.findById(value);
    if (!card) return ok({ value: undefined, events: [] });
    const r = change(card);
    if (!r.ok) return r;
    await deps.cards.save(card);
    return ok({ value: r.value, events: card.pullEvents() });
  });
  if (!done.ok) throw new Error(`The card couldn't be saved: ${done.error.message}`);
  return done.value;
}
