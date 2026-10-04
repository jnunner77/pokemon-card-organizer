/* Bundle sales: several cards sold together for one price, split across the cards.
   Shares are worked out in cents and always add up to the total exactly: the cents left over
   after rounding go to the cards whose shares were rounded down the most.
   A plain script: the page uses window.BinderSales, and the tests load it the same way. */
(function (root) {
  "use strict";

  const cents = n => Math.round(Number(n) * 100);

  /* Weights for "value": each card's market value; a card without one counts as the average of
     the others, and with no values at all every card counts the same. */
  function weights(values, method) {
    const known = values.filter(v => typeof v === "number" && v > 0);
    if (method !== "value" || !known.length) return values.map(() => 1);
    const avg = known.reduce((a, b) => a + b, 0) / known.length;
    return values.map(v => (typeof v === "number" && v > 0 ? v : avg));
  }

  /* Split `total` (dollars) across cards with these market values: "value" (in proportion) or
     "even". Returns each card's share in dollars, adding up to the total to the cent. */
  function split(total, values, method) {
    const t = cents(total), n = values.length;
    if (!n || !(t >= 0)) return values.map(() => 0);
    const w = weights(values, method), sum = w.reduce((a, b) => a + b, 0);
    const raw = w.map(x => (t * x) / sum), out = raw.map(Math.floor);
    let left = t - out.reduce((a, b) => a + b, 0);
    raw.map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i)
      .forEach(({ i }) => { if (left > 0) { out[i]++; left--; } });
    return out.map(c => c / 100);
  }

  /* What's left of the total to place once these shares are taken (negative: too much). */
  function remaining(total, shares) {
    return (cents(total) - shares.reduce((a, s) => a + cents(s || 0), 0)) / 100;
  }

  root.BinderSales = { split, remaining };
})(typeof window !== "undefined" ? window : globalThis);
