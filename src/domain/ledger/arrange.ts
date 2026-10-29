import { err, ok, type Result } from '#shared/result.ts';
import type { Binder, LayoutPlace } from '../binders/binder.ts';
import type { Card } from '../cards/card.ts';
import { sameCard } from '../cards/identity.ts';
import type { InvalidDocument } from './check-document.ts';

// Sorting a binder: the page puts its cards in an order (release date, price) and says where each
// one goes. It happens all together, and only if it still covers every card in the binder exactly
// once, so nothing is left behind, and only copies of one card share a pocket. Undo sends the old
// places back.

export interface PocketMove {
  readonly cardId: string;
  readonly page: number;
  readonly slot: number;
}

export type ArrangeError =
  | { readonly code: 'BINDER_IS_CASE' }
  | { readonly code: 'BINDER_CHANGED' }
  | { readonly code: 'POCKET_SHARED' }
  | { readonly code: 'POCKET_PAST_PAGE'; readonly pockets: number }
  | InvalidDocument;

export interface Arranged {
  /** The cards that changed pocket (the others were already where they go). */
  readonly moved: readonly Card[];
  /** How many places the binder's saved layout holds, when it was saved. */
  readonly layoutSaved: number | null;
}

/**
 * Move the binder's cards to their new pockets. With `saveLayout`, where they are now is kept on
 * the binder first (its own layout), so the page can put them back after sorting.
 */
export function arrangeBinder(binder: Binder, cardsInBinder: readonly Card[], moves: readonly PocketMove[], o: { readonly saveLayout: boolean; readonly at: Date }): Result<Arranged, ArrangeError> {
  if (binder.isCase) return err({ code: 'BINDER_IS_CASE' });
  const ids = new Set(moves.map((m) => m.cardId));
  const byId = new Map(cardsInBinder.map((c) => [String(c.id), c]));
  if (ids.size !== moves.length || ids.size !== cardsInBinder.length || cardsInBinder.some((c) => !ids.has(c.id))) return err({ code: 'BINDER_CHANGED' });
  const byPocket = new Map<string, Card[]>();
  for (const m of moves) {
    const card = byId.get(m.cardId);
    if (!card) return err({ code: 'BINDER_CHANGED' });
    const key = `${m.page}/${m.slot}`;
    byPocket.set(key, [...(byPocket.get(key) ?? []), card]);
  }
  for (const group of byPocket.values()) {
    const [first, ...rest] = group;
    if (first && rest.some((c) => !sameCard(first.fields, c.fields))) return err({ code: 'POCKET_SHARED' });
  }
  const pockets = binder.pocketsPerPage;
  if (moves.some((m) => m.slot > pockets)) return err({ code: 'POCKET_PAST_PAGE', pockets });

  let layoutSaved: number | null = null;
  if (o.saveLayout) {
    const kept: LayoutPlace[] = [];
    for (const c of cardsInBinder) {
      const { page, slot } = c.place;
      if (page !== null && slot !== null && binder.fits(page, slot)) kept.push({ id: c.id, page, slot });
    }
    const saved = binder.saveLayout(kept, o.at);
    if (!saved.ok) return saved;
    layoutSaved = kept.length;
  }

  const moved: Card[] = [];
  for (const m of moves) {
    const card = byId.get(m.cardId);
    if (!card) return err({ code: 'BINDER_CHANGED' });
    const r = card.moveWithinBinder(m.page, m.slot, o.at);
    if (!r.ok) return r;
    if (r.value) moved.push(card);
  }
  return ok({ moved, layoutSaved });
}
