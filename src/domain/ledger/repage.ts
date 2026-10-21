import { ok, type Result } from '#shared/result.ts';
import { type Binder, type LayoutPlace, PAGE_SIZES } from '../binders/binder.ts';
import type { Card } from '../cards/card.ts';
import type { InvalidDocument } from './check-document.ts';

// Changing a binder's pockets per page (9 to 4, say) keeps its cards in the same order: every
// pocket, empty ones too, is counted from page 1, pocket 1 and laid out again on pages of the new
// size, so cards 5–9 of page 1 go to page 2 instead of vanishing past the page. Its saved layout
// moves the same way.
//
// When a binder whose cards already sit past its page (its size was changed before this rule) is
// saved again, it is read as pages of the smallest size that holds its widest pocket (a card in
// pocket 6 means 9-pocket pages). Its old size isn't kept, so this keeps the cards' order but can only guess the empty
// pockets: right for a 9-pocket binder, but a 12- or 16-pocket one with no card past pocket 9 comes
// back laid out as 9-pocket pages.

/** Move the binder's cards (and saved layout) to keep their order on pages of its size now. */
export function repageBinder(binder: Binder, cardsInBinder: readonly Card[], fromPockets: number, at: Date): Result<readonly Card[], InvalidDocument> {
  if (binder.isCase) return ok([]);
  const to = binder.pocketsPerPage;
  const placed = cardsInBinder.flatMap((card) => {
    const { page, slot } = card.place;
    return page !== null && slot !== null ? [{ card, page, slot }] : [];
  });
  const layout = binder.layoutPlaces;
  const width = pageHolding(Math.max(fromPockets, ...placed.map((p) => p.slot), ...layout.map((p) => p.slot)));
  if (width === to) return ok([]);

  const pocket = (page: number, slot: number) => {
    const n = (page - 1) * width + (slot - 1);
    return { page: Math.floor(n / to) + 1, slot: (n % to) + 1 };
  };
  const moved: Card[] = [];
  for (const { card, page, slot } of placed) {
    const next = pocket(page, slot);
    const r = card.moveWithinBinder(next.page, next.slot, at);
    if (!r.ok) return r;
    if (r.value) moved.push(card);
  }
  if (layout.length) {
    const places: LayoutPlace[] = layout.map((p) => ({ id: p.id, ...pocket(p.page, p.slot) }));
    const r = binder.moveLayout(places, at);
    if (!r.ok) return r;
  }
  return ok(moved);
}

/** The smallest page size with this many pockets (or the count itself, past the largest size). */
function pageHolding(pockets: number): number {
  return PAGE_SIZES.find((size) => size >= pockets) ?? pockets;
}
