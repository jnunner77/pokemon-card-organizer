/* Move cards to a binder: where each one goes. At the end puts them after the binder's last card;
   at a pocket puts them there in order, and any card in the way shifts along to the next empty
   pocket (only as far as it must: a gap stops the shifting). The pockets the moving cards leave
   stay empty. A pocket's copies of one card move as one unit (an array of ids), and shift along
   together; a unit landing on a pocket that holds copies of the same card joins them instead, and
   nothing shifts. A display case (pockets null) has no pockets: the cards just go in it, with a blank
   page and pocket, and nothing shifts. A plain script: the page uses window.BinderMove, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* pocket number (from 0, page by page) → the ids of the cards in it; cards being moved don't count */
  function occupied(n, cards, moving) {
    const occ = new Map();
    for (const c of cards) {
      if (moving.has(c.id) || !(c.page >= 1) || !(c.slot >= 1) || c.slot > n) continue;
      const i = (c.page - 1) * n + (c.slot - 1);
      occ.set(i, [...(occ.get(i) || []), c.id]);
    }
    return occ;
  }
  const spot = (n, i) => ({ page: Math.floor(i / n) + 1, slot: (i % n) + 1 });

  /* The pocket after the binder's last card, not counting the cards being moved (null in a case). */
  function end(pockets, cards, ids) {
    if (!pockets) return null;
    const occ = occupied(pockets, cards, new Set(ids.flat()));
    return spot(pockets, occ.size ? Math.max(...occ.keys()) + 1 : 0);
  }

  /* pockets: the binder's pockets per page (null for a display case). cards: the cards in it now
     ({id, page, slot}). ids: the cards to move, in order; each entry is a card id, or an array of
     ids that move together into one pocket (a pocket's copies). (Some may be in this binder
     already.) at: {page, slot}, or null for the end. o.joins(unitIds, occupantIds): whether the
     first unit may join the cards in the pocket it lands on (they are copies of the same card).
     Returns {moves: [{id, page, slot}] one per card, shifted: how many other cards move}. */
  function plan(pockets, cards, ids, at, o = {}) {
    const units = ids.map((u) => (Array.isArray(u) ? u : [u]));
    const all = units.flat();
    if (!pockets) return { moves: all.map((id) => ({ id, page: null, slot: null })), shifted: 0 };
    const n = pockets, occ = occupied(n, cards, new Set(all));
    const first = at || end(n, cards, units);
    const queue = units.slice(), moves = [];
    for (let i = (first.page - 1) * n + (first.slot - 1), k = 0; queue.length; i++, k++) {
      if (occ.has(i)) {
        if (!(k === 0 && at && o.joins && o.joins(queue[0], occ.get(i)))) queue.push(occ.get(i));
      }
      for (const id of queue.shift()) moves.push({ id, ...spot(n, i) });
    }
    return { moves, shifted: moves.length - all.length };
  }

  /* The binder the Move dialog starts on: the one you're in (binder or display case), else the
     one picked last time, else the first binder. ids: the binders in tab order. */
  function target(ids, current, last) {
    if (ids.includes(current)) return current;
    if (ids.includes(last)) return last;
    return ids[0] ?? null;
  }

  root.BinderMove = { plan, end, target };
})(typeof window !== "undefined" ? window : globalThis);
