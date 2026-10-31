/* The price guests see on a card, set by the person in CAD (guestPrice; none: guests see the market
   value rounded up to the dollar). The server keeps the same rule (src/domain/guests/guest-card.ts).
   A plain script: the page uses window.BinderGuestPrice, and the tests load it the same way. */
(function (root) {
  "use strict";

  const MAX = 100000000;
  /* The card's price for guests, or null. */
  const priceOf = c => { const v = c && c.guestPrice; return typeof v === "number" && isFinite(v) && v > 0 ? v : null; };

  /* "3", "$2.50", "4,50" → 3 or 2.5 or 4.5; blank → null; anything else → NaN. */
  function parse(s) {
    const raw = String(s ?? "").trim().replace(/\s/g, "");
    if (!raw) return null;
    const t = raw.replace(/^\$/, "").replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(t) && !/^\.\d{1,2}$/.test(t)) return NaN;
    const n = Number(t);
    return n >= 0.01 && n <= MAX ? n : NaN;
  }

  /* The fields to save from what was typed (blank: none), or {error}. */
  function fromInput(s) {
    const n = parse(s);
    return Number.isNaN(n) ? { error: "The price for guests should be an amount, like 3 or 2.50." } : { guestPrice: n };
  }

  /* The price all the cards share, as typed in the box ("3.00"), or "" when they differ or none is set. */
  function sameText(cards) {
    const first = cards.length ? priceOf(cards[0]) : null;
    return first != null && cards.every(c => priceOf(c) === first) ? first.toFixed(2) : "";
  }

  const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
  /* What was saved, for the toast. */
  function words(n, price) {
    const cards = `${n} card${n === 1 ? "" : "s"}`;
    return price == null ? `Guests see the market value for ${cards}` : `Guests see ${cards} at ${cad.format(price).replace(/^CA/, "")}`;
  }

  root.BinderGuestPrice = { priceOf, parse, fromInput, sameText, words };
})(typeof window !== "undefined" ? window : globalThis);
