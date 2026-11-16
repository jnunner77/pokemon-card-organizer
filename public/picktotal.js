/* The total value of the selected cards, for the selection bar. Cards that are counted (as in
   Est. value held) add their value, in cents so there are no float leftovers; counted cards with
   no price are tallied as unpriced, and the rest as not counted.
   A plain script: the page uses window.BinderPickTotal, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* cards: array; value(c): CAD number or null; counted(c): whether the card is in the totals. */
  function total(cards, value, counted) {
    let cents = 0, priced = 0, unpriced = 0, notCounted = 0;
    for (const c of Array.isArray(cards) ? cards : []) {
      if (!counted(c)) { notCounted++; continue; }
      const v = value(c);
      if (typeof v === "number" && isFinite(v)) { cents += Math.round(v * 100); priced++; }
      else unpriced++;
    }
    return { sum: cents / 100, priced, unpriced, notCounted };
  }

  /* What to say next to the total: how many have no price and how many aren't counted. */
  function note(t) {
    const parts = [];
    if (t.unpriced) parts.push(`${t.unpriced} unpriced`);
    if (t.notCounted) parts.push(`${t.notCounted} not counted`);
    return parts.join(" · ");
  }

  root.BinderPickTotal = { total, note };
})(typeof window !== "undefined" ? window : globalThis);
