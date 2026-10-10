/* Fixing a card's past daily prices after one of its sources was matched to the wrong card (a
   reprint priced as its original): each automatic daily price is worked out again from the
   sources the person keeps, the highest of them at that day's rate, and a day with none of them
   left is removed. Prices the person logged themselves are never touched. A plain script: the
   page uses window.BinderPastPrices, and the tests load it the same way. */
(function (root) {
  "use strict";

  const NAME = { pricecharting: "PriceCharting", tcgplayer: "TCGplayer", cardmarket: "Cardmarket" };
  const KEY = { PriceCharting: "pricecharting", TCGplayer: "tcgplayer", Cardmarket: "cardmarket" };
  const round2 = n => Math.round(n * 100) / 100;

  /* An automatic daily price's sources and their US$ prices: its quotes, or (an older entry) the one it names. */
  function quotesOf(e) {
    if (e.quotes && typeof e.quotes === "object") {
      const q = {};
      for (const [k, v] of Object.entries(e.quotes)) if (typeof v === "number" && v > 0) q[k] = v;
      if (Object.keys(q).length) return q;
    }
    const k = KEY[e.where];
    return k ? { [k]: Number(e.usd) > 0 ? Number(e.usd) : null } : {};
  }

  /* The sources a card's automatic daily prices came from, most used first. */
  function sources(prices) {
    const n = {};
    for (const e of prices || []) if (e && e.auto) for (const k of Object.keys(quotesOf(e))) n[k] = (n[k] || 0) + 1;
    return Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b));
  }

  /*
   * The card's prices with only the `keep` sources in its automatic daily prices. Returns the new
   * list and what happened to each daily price that changed: {date, before, after} (after null
   * when it's removed), newest first.
   */
  function keepOnly(prices, keep) {
    const kept = new Set(keep);
    const rows = [];
    const out = [];
    for (const e of prices || []) {
      if (!e || !e.auto) { out.push(e); continue; }
      const q = quotesOf(e);
      const all = Object.keys(q);
      const left = all.filter(k => kept.has(k));
      if (left.length === all.length) { out.push(e); continue; }
      const dropped = all.filter(k => !kept.has(k)).map(k => NAME[k] || k);
      // A graded price is PriceCharting's for the grade; others need that day's rate to recompute.
      const rate = Number(e.usd) > 0 ? Number(e.amount) / Number(e.usd) : null;
      const priced = left.filter(k => q[k] != null).map(k => [k, q[k]]).sort((a, b) => b[1] - a[1]);
      if (!priced.length || rate == null || !(rate > 0) || (e.grade && !left.includes("pricecharting"))) {
        rows.push({ date: e.date || "", before: e.amount, after: null, where: e.where || "" });
        continue;
      }
      const [src, usd] = priced[0];
      const quotes = Object.fromEntries(left.filter(k => q[k] != null).map(k => [k, q[k]]));
      const list = priced.map(([k, v]) => `${NAME[k] || k} US$${v.toFixed(2)}`);
      const next = {
        ...e,
        amount: round2(usd * rate),
        usd,
        where: NAME[src] || src,
        quotes,
        note: `Daily update · ${list.length > 1 ? `higher of ${list.join(" and ")}` : list[0]} at ${rate.toFixed(4)} · ${dropped.join(" and ")} left out (matched to the wrong card)`,
      };
      out.push(next);
      rows.push({ date: e.date || "", before: e.amount, after: next.amount, where: next.where });
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { prices: out, rows, changed: rows.filter(r => r.after != null).length, removed: rows.filter(r => r.after == null).length };
  }

  /* What to keep at first: the card's main product's site when its prices disagree (that's the one
     it's priced from meanwhile), otherwise every source. */
  function suggested(card) {
    const all = sources(card && card.prices);
    const main = card && card.pricing && card.pricing.disagree && card.pricing.source;
    return main && all.includes(main) ? [main] : all;
  }

  root.BinderPastPrices = { sources, keepOnly, suggested, NAME };
})(typeof window !== "undefined" ? window : globalThis);
