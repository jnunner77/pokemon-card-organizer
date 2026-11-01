/* What the guest page works out about binders: which binders hold cards for sale, their pages, and
   which pocket each card sits in. Cards are what the server sends guests (each with a `place`, or
   null). A plain script: the guest page uses window.GuestBinder, and the tests load it the same
   way. */
(function (root) {
  "use strict";

  const WIDTHS = [4, 9, 12, 16];
  const COLS = { 4: 2, 9: 3, 12: 4, 16: 4 };
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));

  /* In a binder's pages (both page and pocket known), as opposed to a card in a case or without a place. */
  const inBinder = (c, id) => !!c.place && c.place.binderId === id && c.place.kind === "binder" && !!c.place.page && !!c.place.pocket;
  const inCase = (c, id) => !!c.place && c.place.binderId === id && c.place.kind === "case";

  /* The binders and display cases holding at least one card, in the owner's order. */
  function binders(cards) {
    const found = new Map();
    for (const c of cards) {
      const p = c.place;
      if (!p || (p.kind === "binder" && !(p.page && p.pocket))) continue;
      let b = found.get(p.binderId);
      if (!b) found.set(p.binderId, b = { id: p.binderId, name: p.binder, color: p.color, kind: p.kind, pockets: p.pockets, order: p.order, count: 0 });
      b.count++;
    }
    return [...found.values()].sort((a, b) => a.order - b.order || String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /* A binder's cards in page and pocket order (a display case's in name order). */
  function cardsIn(id, cards) {
    return cards.filter((c) => inBinder(c, id) || inCase(c, id)).sort((a, b) => {
      const pa = a.place, pb = b.place;
      return (pa.page || 0) - (pb.page || 0) || (pa.pocket || 0) - (pb.pocket || 0) || byName(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }

  /* The page numbers that hold a card, lowest first. */
  function pages(id, cards) {
    return [...new Set(cards.filter((c) => inBinder(c, id)).map((c) => c.place.page))].sort((a, b) => a - b);
  }

  /* Pockets across a page: the binder's size, widened to fit the widest pocket in use. */
  function width(pockets, cards) {
    const widest = cards.reduce((m, c) => Math.max(m, (c.place && c.place.pocket) || 0), 0);
    const need = Math.max(pockets || 0, widest);
    return WIDTHS.find((w) => w >= need) || widest;
  }

  const cols = (n) => COLS[n] || Math.ceil(Math.sqrt(n));

  /* A page's pockets: entry k holds the cards in pocket k+1 (an empty array when none is for sale). */
  function cells(id, page, cards) {
    const here = cardsIn(id, cards).filter((c) => c.place.page === page);
    const own = cards.filter((c) => c.place && c.place.binderId === id);
    const n = width(own.length ? own[0].place.pockets : 0, own);
    const out = Array.from({ length: n }, () => []);
    for (const c of here) out[c.place.pocket - 1].push(c);
    return out;
  }

  /* The page to show: this one when it has cards, else the closest one (the lower on a tie). */
  function pageNear(page, list) {
    if (!list.length) return null;
    if (list.includes(page)) return page;
    let best = list[0];
    for (const p of list) if (Math.abs(p - page) < Math.abs(best - page)) best = p;
    return best;
  }

  /* "Trade · Page 2 · Pocket 3", "Showcase (display case)", or "" when guests aren't told. */
  function placeText(p) {
    if (!p) return "";
    if (p.kind === "case") return p.binder + " (display case)";
    return p.page && p.pocket ? p.binder + " · Page " + p.page + " · Pocket " + p.pocket : p.binder;
  }

  root.GuestBinder = { binders, cardsIn, pages, width, cols, cells, pageNear, placeText };
})(typeof window !== "undefined" ? window : globalThis);
