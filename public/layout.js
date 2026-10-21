/* A binder's own layout: where each card was before the binder was sorted, so it can be put back
   after sorting by release date or price, as often as you like. The server saves the layout
   with the first sort; this works out the moves that put it back. A plain script: the page uses
   window.BinderLayout, and the tests load it the same way. */
(function (root) {
  "use strict";

  const index = (n, p) => (p.page - 1) * n + (p.slot - 1);
  const spot = (n, i) => ({ page: Math.floor(i / n) + 1, slot: (i % n) + 1 });
  const fits = (n, p) => !!p && p.page >= 1 && p.slot >= 1 && p.slot <= n && Number.isInteger(p.page) && Number.isInteger(p.slot);

  /* pockets: the binder's pockets per page. cards: the cards in it now ({id, page, slot}).
     layout: the saved layout ({places: [{id, page, slot}]}). Each card with a saved place goes
     back to it; cards added since (or whose place no longer fits the page) follow the last saved
     card in their current order. Cards removed since are skipped.
     Returns {moves: [{id, page, slot}] for every card, moved: how many change place, added: how
     many weren't in the layout}. */
  function restore(pockets, cards, layout) {
    const n = pockets, here = new Set(cards.map((c) => c.id));
    const saved = new Map(), taken = new Set();
    for (const p of (layout && layout.places) || []) {
      if (!here.has(p.id) || saved.has(p.id) || !fits(n, p) || taken.has(index(n, p))) continue;
      saved.set(p.id, p);
      taken.add(index(n, p));
    }
    const byPlace = (a, b) => (fits(n, a) ? index(n, a) : Number.MAX_SAFE_INTEGER) - (fits(n, b) ? index(n, b) : Number.MAX_SAFE_INTEGER);
    const rest = cards.filter((c) => !saved.has(c.id)).sort(byPlace);
    let next = taken.size ? Math.max(...taken) + 1 : 0;
    const placed = new Map();
    for (const c of rest) placed.set(c.id, spot(n, next++));
    const moves = cards.map((c) => ({ id: c.id, ...(saved.has(c.id) ? { page: saved.get(c.id).page, slot: saved.get(c.id).slot } : placed.get(c.id)) }));
    const cur = new Map(cards.map((c) => [c.id, c]));
    const moved = moves.filter((m) => cur.get(m.id).page !== m.page || cur.get(m.id).slot !== m.slot).length;
    return { moves, moved, added: rest.length };
  }

  /* Whether the binder is in its saved layout now (nothing would move putting it back). */
  function current(pockets, cards, layout) {
    return !!layout && restore(pockets, cards, layout).moved === 0;
  }

  /* The page to show after the binder's pockets per page change from `from` to `to`: the one that
     now holds the first pocket of the page you were on, so you see the same cards (the server
     moves them to keep their order, empty pockets too). */
  function pageAfterResize(page, from, to) {
    return spot(to, index(from, { page: Math.max(1, page | 0), slot: 1 })).page;
  }

  /* How wide the binder's pages are read when its size changes, as the server reads them: its
     pockets per page, or for a binder an older version left with cards past its page, the smallest
     page size that holds its widest pocket in use (its cards' and saved layout's). */
  function widthOf(pockets, cards, layout) {
    const used = [...cards, ...((layout && layout.places) || [])].map((p) => (p && Number.isInteger(p.page) && Number.isInteger(p.slot) ? p.slot : 0));
    const widest = Math.max(pockets, ...used);
    return [4, 9, 12, 16].find((n) => n >= widest) || widest;
  }

  /* What saving the binder's settings does to the page shown. page: the page you were on before
     saving (the moved cards can arrive, and re-render, before the save answers). from: its width
     before (widthOf), to: its pockets per page after (null for a display case). The page to show, or null to
     leave the page as it is (the size didn't change). */
  function pageAfterSave(page, from, to) {
    return from && to && from !== to ? pageAfterResize(page, from, to) : null;
  }

  /* The page to show: page, kept between 1 and the page after the last one with cards. held: a
     page the view was just sent to after a size change, allowed even past that while the moved
     cards are still on their way (they can arrive after the save answers). */
  function pageInView(page, lastPage, held) {
    return Math.min(Math.max(1, page | 0), Math.max(lastPage + 1, held || 0));
  }

  root.BinderLayout = { restore, current, pageAfterResize, pageAfterSave, widthOf, pageInView };
})(typeof window !== "undefined" ? window : globalThis);
