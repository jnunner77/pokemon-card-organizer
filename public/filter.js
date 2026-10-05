/* The List view's filters: owner, set, rarity, status, release year and value. A card shows when it
   matches every filter that's set; within Owner, any of the ticked owners. A card with no release
   date or no value doesn't match a year or value filter.
   A plain script: the page uses window.BinderFilter, and the tests load it the same way. */
(function (root) {
  "use strict";

  const EMPTY = { owners: [], set: "", rarity: "", status: "", yFrom: "", yTo: "", vMin: "", vMax: "" };
  const num = v => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
  const setOf = c => c.set || c.setCode || "";

  /* how many filters are set (the Owner ticks count as one) */
  function count(f) {
    f = { ...EMPTY, ...f };
    return (f.owners.length ? 1 : 0) + ["set", "rarity", "status"].filter(k => f[k]).length
      + (num(f.yFrom) != null || num(f.yTo) != null ? 1 : 0) + (num(f.vMin) != null || num(f.vMax) != null ? 1 : 0);
  }

  /* c: the card; f: the filters; value: the card's value in CAD, or null */
  function match(c, f, value) {
    f = { ...EMPTY, ...f };
    if (f.owners.length && !f.owners.includes(c.owner || "")) return false;
    if (f.set && setOf(c) !== f.set) return false;
    if (f.rarity && (c.rarity || "") !== f.rarity) return false;
    if (f.status && (c.status || "binder") !== f.status) return false;
    const yFrom = num(f.yFrom), yTo = num(f.yTo);
    if (yFrom != null || yTo != null) {
      const y = /^\d{4}/.test(c.released || "") ? Number(c.released.slice(0, 4)) : null;
      if (y == null || (yFrom != null && y < yFrom) || (yTo != null && y > yTo)) return false;
    }
    const vMin = num(f.vMin), vMax = num(f.vMax);
    if (vMin != null || vMax != null) {
      if (value == null || (vMin != null && value < vMin) || (vMax != null && value > vMax)) return false;
    }
    return true;
  }

  root.BinderFilter = { EMPTY, count, match, setOf };
})(typeof window !== "undefined" ? window : globalThis);
