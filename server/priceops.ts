import type { Doc } from './schema.ts';
import { HttpError } from './security.ts';

// A card's price entries changed one by one, against the list the server has now, instead of the
// page sending the whole list from its own copy. So an entry the daily update (or another person)
// added since the page last heard about the card isn't lost.

export interface PriceOps {
  /** New entries, appended (one whose id is already there is left as it is). */
  add?: Doc[];
  /** Whole entries that replace the ones with their id. */
  update?: Doc[];
  /** Ids of entries to take out (one already gone is fine). */
  remove?: string[];
}

export function applyPriceOps(list: unknown, ops: PriceOps): Doc[] {
  const remove = new Set(ops.remove ?? []);
  const out = (Array.isArray(list) ? (list as Doc[]) : []).filter((e) => !remove.has(String(e?.id)));
  for (const u of ops.update ?? []) {
    const i = out.findIndex((e) => e?.id === u.id);
    // Changing an entry that was removed meanwhile would bring it back.
    if (i < 0) throw new HttpError(409, 'A price entry was changed or removed meanwhile, so nothing was saved. Try again.', 'conflict');
    out[i] = u;
  }
  for (const a of ops.add ?? []) if (!out.some((e) => e?.id === a.id)) out.push(a);
  return out;
}
