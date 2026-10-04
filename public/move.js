/* Move cards to a binder: where each one goes. At the end puts them after the binder's last card;
   at a pocket puts them there in order, and any card in the way shifts along to the next empty
   pocket (only as far as it must: a gap stops the shifting). The pockets the moving cards leave
   stay empty. A plain script: the page uses window.BinderMove, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* pocket number (from 0, page by page) → card id; cards being moved don't count */
  function occupied(n, cards, moving) {
    const occ = new Map();
    for (const c of cards) {
      if (moving.has(c.id) || !(c.page >= 1) || !(c.slot >= 1) || c.slot > n) continue;
      occ.set((c.page - 1) * n + (c.slot - 1), c.id);
    }
    return occ;
  }
  const spot = (n, i) => ({ page: Math.floor(i / n) + 1, slot: (i % n) + 1 });

  /* The pocket after the binder's last card, not counting the cards being moved. */
  function end(pockets, cards, ids) {
    const occ = occupied(pockets, cards, new Set(ids));
    return spot(pockets, occ.size ? Math.max(...occ.keys()) + 1 : 0);
  }

  /* pockets: the binder's pockets per page. cards: the cards in it now ({id, page, slot}).
     ids: the cards to move, in order (some may be in this binder already). at: {page, slot}, or
     null for the end. Returns {moves: [{id, page, slot}], shifted: how many other cards move}. */
  function plan(pockets, cards, ids, at) {
    const n = pockets, moving = new Set(ids), occ = occupied(n, cards, moving);
    const first = at || end(n, cards, ids);
    const queue = ids.slice(), moves = [];
    for (let i = (first.page - 1) * n + (first.slot - 1); queue.length; i++) {
      if (occ.has(i)) queue.push(occ.get(i));
      moves.push({ id: queue.shift(), ...spot(n, i) });
    }
    return { moves, shifted: moves.length - ids.length };
  }

  root.BinderMove = { plan, end };
})(typeof window !== "undefined" ? window : globalThis);
