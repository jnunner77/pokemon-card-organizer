/* How a card's daily price is worked out from its sources' US$ prices that day (PriceCharting's
   ungraded price, TCGplayer's market price, Cardmarket's trend), the same way on the server (the
   daily update, the history rebuild, the PriceCharting purge) and in the page (Fix past daily
   prices). PriceCharting is the anchor (TCGplayer when PriceCharting has no price, then
   Cardmarket): a source further than the tolerance from it is taken to be another card's price.
   - blend: the weighted average of the sources within the tolerance; a source outside it is left
     out and its weight goes to the anchor; a source with no price shares its weight among the rest.
   - highest: the highest source, unless it's outside the tolerance, then the anchor's price.
   - pricecharting: PriceCharting's price, else TCGplayer's, else Cardmarket's.
   A plain script: the page uses window.BinderBlend, the server and the tests load it the same way. */
(function (root) {
  "use strict";

  const NAME = { pricecharting: "PriceCharting", tcgplayer: "TCGplayer", cardmarket: "Cardmarket" };
  const ORDER = ["pricecharting", "tcgplayer", "cardmarket"];
  const DEFAULTS = { method: "blend", weights: { pricecharting: 40, tcgplayer: 40, cardmarket: 20 }, tolerance: 25 };
  const METHODS = { blend: "Blended", highest: "Highest", pricecharting: "PriceCharting first" };
  const round2 = n => Math.round(n * 100) / 100;
  const pct = n => `${Math.round(n)}%`;

  /* The settings with their defaults filled in. */
  function settings(o) {
    const w = { ...DEFAULTS.weights, ...((o && o.weights) || {}) };
    for (const k of ORDER) w[k] = Number(w[k]) >= 0 ? Number(w[k]) : DEFAULTS.weights[k];
    const t = Number(o && o.tolerance);
    return {
      method: o && METHODS[o.method] ? o.method : DEFAULTS.method,
      weights: w,
      tolerance: t > 0 && t <= 1000 ? t : DEFAULTS.tolerance,
    };
  }

  /*
   * The day's price from `quotes` ({source: US$}). Returns null without any price, else
   * {usd, where, used: {source: share 0-1}, out: [sources left out], anchor, summary}: `where` is
   * the source's name, or "Blend" when more than one source counted.
   */
  function price(quotes, opts) {
    const o = settings(opts);
    const q = {};
    for (const k of ORDER) if (quotes && typeof quotes[k] === "number" && quotes[k] > 0) q[k] = quotes[k];
    const have = ORDER.filter(k => q[k] != null);
    if (!have.length) return null;
    const anchor = have[0];
    // (A hair of leeway: 1.20 to 1.50 is exactly 25%, not 25.000000000000004%.)
    const off = k => Math.abs(q[k] - q[anchor]) / q[anchor] * 100 > o.tolerance + 1e-9;
    const out = have.filter(k => k !== anchor && off(k));
    const fmt = k => `${NAME[k]} US$${q[k].toFixed(2)}`;
    const why = out.length ? ` · left out (more than ${pct(o.tolerance)} from ${NAME[anchor]}): ${out.map(fmt).join(", ")}` : "";

    if (o.method === "pricecharting") {
      return { usd: q[anchor], where: NAME[anchor], used: { [anchor]: 1 }, out: [], anchor, summary: `${fmt(anchor)}${have.length > 1 ? ` (${METHODS.pricecharting})` : ""}` };
    }
    if (o.method === "highest") {
      const top = have.reduce((a, b) => (q[b] > q[a] ? b : a));
      if (top !== anchor && off(top)) {
        return { usd: q[anchor], where: NAME[anchor], used: { [anchor]: 1 }, out: [top], anchor, summary: `${fmt(anchor)} · the highest, ${fmt(top)}, is more than ${pct(o.tolerance)} from ${NAME[anchor]}` };
      }
      const list = have.map(fmt);
      return { usd: q[top], where: NAME[top], used: { [top]: 1 }, out: [], anchor, summary: list.length > 1 ? `highest of ${list.join(", ")}` : list[0] };
    }
    // Blend: shares of the sources counted; a source left out gives its weight to the anchor, a
    // missing one shares it among the rest (by their weights).
    const w = {};
    for (const k of have) if (!out.includes(k)) w[k] = o.weights[k];
    for (const k of out) w[anchor] += o.weights[k];
    let total = Object.values(w).reduce((a, b) => a + b, 0);
    if (!(total > 0)) { for (const k in w) w[k] = 1; total = Object.keys(w).length; }
    const used = {};
    let usd = 0;
    for (const k of Object.keys(w)) { used[k] = w[k] / total; usd += q[k] * used[k]; }
    usd = round2(usd);
    const counted = Object.keys(used).length;
    const parts = Object.keys(used).map(k => (counted > 1 ? `${fmt(k)} (${pct(used[k] * 100)})` : fmt(k)));
    return { usd, where: counted > 1 ? "Blend" : NAME[anchor], used, out, anchor, summary: `${counted > 1 ? "blend of " : ""}${parts.join(", ")}${why}` };
  }

  root.BinderBlend = { price, settings, DEFAULTS, METHODS, NAME };
})(typeof window !== "undefined" ? window : globalThis);
