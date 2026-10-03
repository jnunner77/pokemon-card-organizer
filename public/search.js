/* Find a card by Pokémon name, set name, set code or set number.
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
    return best;
  }

  function fields(c) {
    return {
      nameWords: words(c.name), nameCompact: compact(c.name),
      setWords: words(c.set), setCompact: compact(c.set),
      code: compact(c.setCode),
      number: norm(c.number).replace(/\s+/g, ""), numPart: numPart(c.number),
    };
  }

  /**
   * The cards matching `query`, best first: [{card, score}].
   * options.limit: most results (default 50); options.order(card): tie-break key, smaller first.
   */
  function search(cards, query, options) {
    const o = options || {};
    const q = words(query);
    if (!q.length) return [];
    const out = [];
    for (const card of cards || []) {
      const f = fields(card);
      let score = 0;
      for (const w of q) {
        const s = scoreWord(w, f);
        if (!s) { score = 0; break; }
        score += s;
      }
      if (score) out.push({ card, score });
    }
    const order = o.order || (() => "");
    out.sort((a, b) => b.score - a.score || String(order(a.card)).localeCompare(String(order(b.card))) || String(a.card.name || "").localeCompare(String(b.card.name || "")));
    return out.slice(0, o.limit ?? 50);
  }

  root.BinderSearch = { search, norm };
})(typeof window !== "undefined" ? window : globalThis);
