/* Duplicate cards, one or more copies of each: where each copy goes. Copies go in the next empty
   pockets after their card, in order (then the binder's first gaps, then new pages), copies of one
   card before the next card's. In a display case (no pockets) a copy just goes in the case, and a
   card that isn't in a binder makes copies that aren't either. A Duplicate makes at most MAX copies
   in all (each one is a change sent to the server, which limits how many come at once), except
   that one copy of each of any number of selected cards is always allowed.
   A plain script: the page uses window.BinderDuplicate, and the tests load it the same way. */
(function (root) {
  "use strict";

  const MAX = 50;

  /* Most copies of each card for a Duplicate of `cards` cards. */
  const most = cards => Math.max(1, Math.floor(MAX / Math.max(1, cards)));

  /* The copies asked for ("3"), as a whole number from 1 to most(cards), or null. */
  function count(value, cards) {
    const t = String(value ?? "").trim();
    const n = /^\d+$/.test(t) ? Number(t) : NaN;
    return n >= 1 && n <= most(cards) ? n : null;
  }

  /* The next empty pocket after page/slot, in a binder of `pockets` per page whose last card is on
     `lastPage`; busy(page, slot) says whether a pocket is taken. */
  function nextFree(pockets, busy, lastPage, taken, page, slot) {
    const last = lastPage + Math.ceil((taken + 1) / pockets) + 1;
    const from = Math.max(1, page || 1);
    for (let p = from; p <= last; p++) for (let s = p === from ? (slot || 0) + 1 : 1; s <= pockets; s++) if (!busy(p, s)) return { page: p, slot: s };
    for (let p = 1; p <= last; p++) for (let s = 1; s <= pockets; s++) if (!busy(p, s)) return { page: p, slot: s };
    return { page: last + 1, slot: 1 };
  }

  /* sources: the cards to copy ({id, binderId, page, slot}), in binder order. times: copies of each.
     binder(id): {pockets} for a binder (pockets null for a display case), or null when there's no
     such binder. cardAt(binderId, page, slot): whether a card is there now. lastPage(binderId): the
     binder's last page with a card. Returns one {id, binderId, page, slot} per copy (id: the card
     it copies), each card's copies together. */
  function plan(sources, times, binder, cardAt, lastPage) {
    const taken = new Map();
    const out = [];
    for (const c of sources) {
      const b = c.binderId ? binder(c.binderId) : null;
      for (let k = 0; k < times; k++) {
        if (!b) { out.push({ id: c.id, binderId: null, page: null, slot: null }); continue; }
        if (!b.pockets) { out.push({ id: c.id, binderId: c.binderId, page: null, slot: null }); continue; }
        const t = taken.get(c.binderId) || new Set();
        taken.set(c.binderId, t);
        const spot = nextFree(b.pockets, (p, s) => !!cardAt(c.binderId, p, s) || t.has(p + ":" + s), lastPage(c.binderId), t.size, c.page, c.slot);
        t.add(spot.page + ":" + spot.slot);
        out.push({ id: c.id, binderId: c.binderId, page: spot.page, slot: spot.slot });
      }
    }
    return out;
  }

  root.BinderDuplicate = { MAX, most, count, plan };
})(typeof window !== "undefined" ? window : globalThis);
