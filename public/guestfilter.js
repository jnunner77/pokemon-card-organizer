/* The guest page's filters: set, release year, price, rarity, variant, language, condition or grade
   and illustrator, over the cards for sale. A card shows when it matches every filter that's set; a
   card with no release date or no price doesn't match a year or price range. Never by owner.
   A plain script: the page uses window.GuestFilter, and the tests load it the same way. */
(function (root) {
  "use strict";

  const EMPTY = { set: "", yFrom: "", yTo: "", pMin: "", pMax: "", rarity: "", variant: "", language: "", shape: "", artist: "" };
  /* the fields picked from a list of the values on the cards (exact match) */
  const FIELDS = ["set", "rarity", "variant", "language", "shape", "artist"];
  const num = v => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
  const setOf = c => c.set || c.setCode || "";
  /* graded cards show the grader and grade; others their condition */
  const shapeOf = c => (c.grader && c.grader !== "Raw" ? [c.grader, c.grade].filter(Boolean).join(" ") : (c.condition || ""));
  const yearOf = c => (/^\d{4}/.test(c.released || "") ? c.released.slice(0, 4) : "");
  const valueOf = (field, c) => (field === "set" ? setOf(c) : field === "shape" ? shapeOf(c) : (c[field] || ""));

  /* how many filters are set (each range counts as one) */
  function count(f) {
    f = { ...EMPTY, ...f };
    return FIELDS.filter(k => f[k]).length + (num(f.yFrom) != null || num(f.yTo) != null ? 1 : 0) + (num(f.pMin) != null || num(f.pMax) != null ? 1 : 0);
  }

  function match(c, f) {
    f = { ...EMPTY, ...f };
    for (const k of FIELDS) if (f[k] && valueOf(k, c) !== f[k]) return false;
    const yFrom = num(f.yFrom), yTo = num(f.yTo);
    if (yFrom != null || yTo != null) {
      const y = yearOf(c) ? Number(yearOf(c)) : null;
      if (y == null || (yFrom != null && y < yFrom) || (yTo != null && y > yTo)) return false;
    }
    const pMin = num(f.pMin), pMax = num(f.pMax);
    if (pMin != null || pMax != null) {
      const v = c.value;
      if (v == null || (pMin != null && v < pMin) || (pMax != null && v > pMax)) return false;
    }
    return true;
  }

  /* The values to pick from, with how many cards have each. A value that's picked but no longer on
     any card stays in the list with 0, so the picker still shows it. */
  function choices(cards, f) {
    f = { ...EMPTY, ...f };
    const out = {};
    for (const k of FIELDS) {
      const seen = new Map();
      for (const c of cards) { const v = valueOf(k, c); if (v) seen.set(v, (seen.get(v) || 0) + 1); }
      if (f[k] && !seen.has(f[k])) seen.set(f[k], 0);
      let list = [...seen].map(([value, n]) => ({ value, label: value, count: n }));
      if (k === "set") {
        const latest = new Map();
        for (const c of cards) { const s = setOf(c), r = c.released || ""; if (s && r > (latest.get(s) || "")) latest.set(s, r); }
        list.sort((a, b) => (latest.get(b.value) || "").localeCompare(latest.get(a.value) || "") || a.value.localeCompare(b.value));
      } else list.sort((a, b) => a.value.localeCompare(b.value));
      out[k] = list;
    }
    const years = new Map();
    for (const c of cards) { const y = yearOf(c); if (y) years.set(y, (years.get(y) || 0) + 1); }
    for (const y of [f.yFrom, f.yTo]) if (/^\d{4}$/.test(y) && !years.has(y)) years.set(y, 0);
    out.years = [...years].sort((a, b) => a[0].localeCompare(b[0])).map(([value, n]) => ({ value, label: value, count: n }));
    return out;
  }

  /* filters kept for the tab: only the known keys, only text */
  function fromStore(x) {
    const f = { ...EMPTY };
    if (x && typeof x === "object" && !Array.isArray(x)) for (const k of Object.keys(EMPTY)) if (typeof x[k] === "string") f[k] = x[k].slice(0, 200);
    return f;
  }

  root.GuestFilter = { EMPTY, FIELDS, count, match, choices, fromStore, setOf, shapeOf, yearOf };
})(typeof window !== "undefined" ? window : globalThis);
