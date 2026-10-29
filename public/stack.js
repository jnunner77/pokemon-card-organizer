/* Several copies of one card in one binder pocket. A pocket holds copies of one card: two cards
   are the same card when their name, number, set, variant and language match (condition, grade,
   owner, status and price don't matter: each copy keeps its own). Case, accents and punctuation
   don't matter, 51 and 051/162 are the same number, a blank set matches any set, and a blank
   language counts as English. This mirrors src/domain/cards/identity.ts (the server applies the
   rule too): keep the two in step, and tests/domain/cards/identity.test.ts and
   tests/legacy/stack.test.ts on the same cases.
   A plain script: the page uses window.BinderStack, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* "Pokémon", "N's", "V Star" → "pokemon", "ns", "vstar" */
  const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  /* "051" → "51", "51/162" → "51", "SWSH298" → "swsh298" */
  const ownNumber = (s) => {
    const n = (String(s == null ? "" : s).split("/")[0] || "").replace(/\s+/g, "").toLowerCase();
    return /^\d+$/.test(n) ? String(Number(n)) : n;
  };
  /* "51/162" → 162 */
  const setSize = (s) => {
    const m = /\/\s*(\d+)\s*$/.exec(String(s == null ? "" : s));
    return m ? Number(m[1]) : null;
  };
  /* "Pokemon Base Set" → "Base Set" */
  const setLabel = (s) => String(s == null ? "" : s).replace(/^\s*pok[eé]mon\s+/i, "").trim();
  const blank = (v) => v == null || String(v).trim() === "";
  const text = (v) => (typeof v === "string" ? v : "");

  function sameSet(a, b) {
    if (!blank(text(a.setCode)) && !blank(text(b.setCode))) return norm(a.setCode) === norm(b.setCode);
    if (!blank(text(a.set)) && !blank(text(b.set))) return norm(setLabel(a.set)) === norm(setLabel(b.set));
    return true;
  }

  /* Whether two cards are copies of the same printing. */
  function same(a, b) {
    if (norm(a.name) !== norm(b.name)) return false;
    if (ownNumber(a.number) !== ownNumber(b.number)) return false;
    const sa = setSize(a.number), sb = setSize(b.number);
    if (sa !== null && sb !== null && sa !== sb) return false;
    if (!sameSet(a, b)) return false;
    if (norm(a.variant) !== norm(b.variant)) return false;
    return norm(text(a.language) || "English") === norm(text(b.language) || "English");
  }

  const held = (c) => c.status !== "sold" && c.status !== "traded";

  /* Which copy shows on top of a pocket: held before sold or traded, real cards before
     placeholders, then the oldest, then by id. A comparator. */
  function order(a, b) {
    return (held(b) ? 1 : 0) - (held(a) ? 1 : 0)
      || (a.placeholder ? 1 : 0) - (b.placeholder ? 1 : 0)
      || String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  /* The cards grouped into units that move together: a pocket's copies of one card (the top copy
     leads). A card of another kind in the same pocket, and a card with no pocket, is a unit of its
     own. Units come in the order their lead is in `cards`. */
  function units(cards) {
    const pockets = new Map(), at = new Map(cards.map((c, i) => [c.id, i]));
    const alone = [];
    for (const c of cards) {
      if (!(c.page >= 1) || !(c.slot >= 1)) { alone.push([c]); continue; }
      const key = c.binderId + "/" + c.page + "/" + c.slot;
      if (!pockets.has(key)) pockets.set(key, []);
      pockets.get(key).push(c);
    }
    const out = alone.slice();
    for (const list of pockets.values()) {
      const sorted = list.slice().sort(order), lead = sorted[0];
      // a card joins the lead's unit only when it is the same card as every card already in it
      // (the rule isn't transitive: a blank set matches two sets that don't match each other)
      const mine = [lead];
      for (const c of sorted) if (c !== lead && mine.every((x) => same(x, c))) mine.push(c);
      out.push(mine);
      for (const c of sorted) if (!mine.includes(c)) out.push([c]);
    }
    return out.sort((a, b) => at.get(a[0].id) - at.get(b[0].id));
  }

  /* Whether `card` may be in a pocket holding `list`: they are all copies of it (or itself). */
  const fits = (list, card) => list.every((x) => x.id === card.id || same(x, card));

  /* Whether a pocket's cards aren't all copies of one card. */
  const mixed = (list) => list.some((x, i) => list.slice(i + 1).some((y) => !same(x, y)));

  root.BinderStack = { same, order, units, fits, mixed };
})(typeof window !== "undefined" ? window : globalThis);
