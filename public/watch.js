/* Price watches: a price to buy a card at (at or below) or sell it at (at or above), in CAD. The
   server emails a buy alert and a separate sell alert when cards' values reach them (the same rules
   as src/domain/cards/watch.ts). A card can be watched to buy without being in the collection: it's
   on the watchlist (watchlist: true), a placeholder in no binder, priced every day but in no total.
   A plain script: the page uses window.BinderWatch, and the tests load it the same way. */
(function (root) {
  "use strict";

  const SIDES = ["buy", "sell"];
  const positive = v => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
  const cents = n => Math.round(n * 100) / 100;

  /* The prices the card is watched for (null: that side isn't watched). */
  function targets(c) {
    const w = c && c.watch;
    return w && typeof w === "object" ? { buy: positive(w.buy), sell: positive(w.sell) } : { buy: null, sell: null };
  }
  /* Only on the watchlist: a card the person doesn't have, in no binder. */
  const onWatchlist = c => !!c && c.watchlist === true;
  /* The person has the card, so it can be watched to sell. */
  const owns = c => !!c && !["sold", "traded"].includes(c.status) && !c.placeholder && !onWatchlist(c);
  /* The watches that apply: buying to any card, selling only to one the person has. */
  function active(c) {
    const t = targets(c);
    return { buy: t.buy, sell: owns(c) ? t.sell : null };
  }
  const isWatched = c => { const t = active(c); return t.buy != null || t.sell != null; };

  /* Each watch against the card's value: {side, target, reached, gap: value - target (null without a value)}. */
  function status(c, value) {
    const t = active(c), v = value == null || isNaN(value) ? null : cents(value);
    return SIDES.filter(side => t[side] != null).map(side => {
      const target = t[side];
      return { side, target, reached: v != null && (side === "buy" ? v <= target : v >= target), gap: v == null ? null : cents(v - target) };
    });
  }

  /* "5", "$5.00", "4,50" → 5 or 4.5; blank → null; anything else → NaN. */
  function parsePrice(s) {
    const t = String(s ?? "").trim().replace(/\s/g, "").replace(/^\$/, "").replace(",", ".");
    if (!t) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(t) && !/^\.\d{1,2}$/.test(t)) return NaN;
    const n = Number(t);
    return n > 0 && n <= 100000000 ? n : NaN;
  }

  /* The watch to save from what was typed (both blank: not watched), or {error}. */
  function fromInputs(buyText, sellText) {
    const buy = parsePrice(buyText), sell = parsePrice(sellText);
    if (Number.isNaN(buy)) return { error: "The buy price should be an amount, like 5 or 4.50." };
    if (Number.isNaN(sell)) return { error: "The sell price should be an amount, like 20 or 19.99." };
    return { watch: buy == null && sell == null ? null : { buy, sell } };
  }

  /* A price as typed in a watch field: 5 → "5.00", none → "". */
  const priceText = n => (positive(n) == null ? "" : n.toFixed(2));

  /* How close a card is to a watch: reached ones first (-1), then the smallest share of the price to go. */
  function closeness(c, value) {
    const s = status(c, value);
    if (!s.length) return Infinity;
    return Math.min(...s.map(x => (x.reached ? -1 : x.gap == null ? Infinity : Math.abs(x.gap) / x.target)));
  }

  /* The Watchlist: every watched card and every card only on the watchlist, reached ones first. */
  function list(cards, valueOf) {
    return cards
      .filter(c => isWatched(c) || onWatchlist(c))
      .map(c => ({ c, k: closeness(c, valueOf(c)) }))
      .sort((a, b) => a.k - b.k || String(a.c.name || "").localeCompare(String(b.c.name || "")))
      .map(x => x.c);
  }

  /* How many watched cards have reached a price. */
  const reachedCount = (cards, valueOf) => cards.filter(c => status(c, valueOf(c)).some(x => x.reached)).length;

  /* A new watchlist card from Any card's fields (lookup.js draftFields): in no binder, watched to buy. */
  function watchlistCard(fields, buy, at) {
    return { ...fields, status: "binder", owner: "", placeholder: true, watchlist: true, watch: { buy, sell: null }, binderId: null, page: null, slot: null, prices: [], imageId: null, createdAt: at, updatedAt: at };
  }

  /* The person got a watchlist card: it's theirs now (not in a binder yet), and no longer watched to buy. */
  function gotIt(c) {
    const t = targets(c);
    return { watchlist: false, placeholder: false, watch: t.sell != null ? { buy: null, sell: t.sell } : null };
  }

  root.BinderWatch = { targets, onWatchlist, owns, active, isWatched, status, parsePrice, fromInputs, priceText, list, reachedCount, watchlistCard, gotIt };
})(typeof window !== "undefined" ? window : globalThis);
