/* Find a card by Pokémon name, set name, set code, set number or illustrator.
   Every word of the query has to match one of those on the card ("pikachu m22", "base set 2 118",
   "7/15"); cards matching better come first. Accents, case and punctuation don't matter.
   A plain script: the page uses window.BinderSearch, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* "Pokémon", "N's", "Hole-Digging" → "pokemon", "ns", "hole digging". Keeps "/" for numbers. */
  const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’`.]/g, "").replace(/[^a-z0-9/]+/g, " ").trim();
  const words = s => norm(s).split(" ").filter(Boolean);
  const compact = s => norm(s).replace(/[ /]/g, "");
  /* the card's own number without leading zeros: "031" → "31", "131/128" → "131", "SWSH298" → "swsh298" */
  const numPart = s => { const n = norm(s).split("/")[0].replace(/\s+/g, ""); return /^\d+$/.test(n) ? String(Number(n)) : n; };

  /* How well one query word matches each field, 0 for no match. Higher is better. */
  function scoreWord(w, f) {
    const wNum = /^\d+$/.test(w) ? String(Number(w)) : w;
    let best = 0;
    const take = s => { if (s > best) best = s; };
    if (f.number) {
      if (w.includes("/")) { if (w === f.number) take(60); }
      else if (wNum === f.numPart) take(50);
    }
    if (f.code) {
      if (w === f.code) take(45);
      else if (w.length >= 2 && f.code.startsWith(w)) take(25);
    }
    for (const n of f.nameWords) { if (n === w) take(35); else if (n.startsWith(w)) take(30); }
    if (w.length >= 3 && f.nameCompact.includes(w)) take(12);
    for (const s of f.setWords) { if (s === w) take(22); else if (s.startsWith(w)) take(18); }
    if (w.length >= 3 && f.setCompact.includes(w)) take(8);
    for (const a of f.artistWords) { if (a === w) take(20); else if (a.startsWith(w)) take(15); }
    if (w.length >= 3 && f.artistCompact.includes(w)) take(6);
    return best;
  }

  function fields(c) {
    return {
      nameWords: words(c.name), nameCompact: compact(c.name),
      setWords: words(c.set), setCompact: compact(c.set),
      artistWords: words(c.artist), artistCompact: compact(c.artist),
      code: compact(c.setCode),
      number: norm(c.number).replace(/\s+/g, ""), numPart: numPart(c.number),
    };
  }

  /**
   * The cards matching `query`, best first: [{card, score, copies}].
   * options.limit: most results (default 50); options.order(card): tie-break key, smaller first.
   * options.same(a, b): when given, copies of the same card are listed once, at the first copy in
   * `order` (whether or not that copy matches the query), with `score` the best copy's and `copies`
   * counting every copy in `cards`; the limit counts distinct cards. Without it every matching card is
   * listed with copies 1. same(a, b) must imply the names match, ignoring case, accents and punctuation.
   */
  function search(cards, query, options) {
    const o = options || {};
    const q = words(query);
    if (!q.length) return [];
    const order = o.order || (() => "");
    const byOrder = (a, b) => String(order(a.card)).localeCompare(String(order(b.card))) || String(a.card.name || "").localeCompare(String(b.card.name || ""));
    const limit = o.limit ?? 50;
    const scored = [];
    let i = 0;
    for (const card of cards || []) {
      const f = fields(card);
      let score = 0;
      for (const w of q) {
        const s = scoreWord(w, f);
        if (!s) { score = 0; break; }
        score += s;
      }
      scored.push({ card, score, key: f.nameCompact, i: i++ });
    }
    if (!o.same) {
      return scored.filter(r => r.score).map(r => ({ card: r.card, score: r.score, copies: 1 }))
        .sort((a, b) => b.score - a.score || byOrder(a, b)).slice(0, limit);
    }
    const buckets = new Map();
    for (const r of scored) {
      if (!buckets.has(r.key)) buckets.set(r.key, []);
      buckets.get(r.key).push(r);
    }
    const groups = [];
    for (const list of buckets.values()) {
      if (!list.some(r => r.score)) continue;
      list.sort((a, b) => byOrder(a, b) || a.i - b.i);
      const mine = [];
      for (const e of list) {
        const g = mine.find(x => o.same(x.card, e.card));
        if (g) { g.copies++; g.score = Math.max(g.score, e.score); }
        else mine.push({ card: e.card, score: e.score, copies: 1 });
      }
      groups.push(...mine.filter(g => g.score));
    }
    return groups.sort((a, b) => b.score - a.score || byOrder(a, b)).slice(0, limit);
  }

  root.BinderSearch = { search, norm };
})(typeof window !== "undefined" ? window : globalThis);
