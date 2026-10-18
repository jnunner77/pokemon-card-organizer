import { MAX_PAGE, MAX_POCKETS, OWNERS } from '../cards/card-fields.ts';
import { arrayOf, count, documentIdRule, integer, loose, nullish, number, oneOf, optText, strict, text, type Shape } from '../ledger/rules.ts';

/** case: a display case, holding cards with no pages or pockets (their page and slot are blank). */
export const BINDER_KINDS = ['binder', 'case'] as const;
export type BinderKind = (typeof BINDER_KINDS)[number];

export const BINDER_FIELDS: Shape = {
  name: text(80),
  color: optText(40),
  pockets: nullish(integer(1, MAX_POCKETS)),
  kind: nullish(oneOf(BINDER_KINDS)),
  /** Whose binder it is: a card added to it starts as theirs (Justin's when not set). */
  owner: nullish(oneOf(OWNERS)),
  order: nullish(number()),
  createdAt: optText(40),
  /** The binder's own layout, saved when it was first sorted, so it can be put back after sorting. */
  layout: nullish(
    loose({
      savedAt: text(40),
      places: arrayOf(strict({ id: documentIdRule, page: count(MAX_PAGE), slot: count(MAX_POCKETS) }), 5000),
    }),
  ),
};
