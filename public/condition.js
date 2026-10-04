/* What a card's condition does to its automatic price. The price sites give near-mint market
   prices; a played copy is worth the upper end of the usual range for its condition. Prices the
   person logs themselves are what that copy is worth, and a graded card's grade sets its price,
   so neither is adjusted.
   A plain script: the page uses window.BinderCondition, and the tests load it the same way. */
(function (root) {
  "use strict";

  const FACTORS = { "Near Mint": 1, "Lightly Played": 0.85, "Moderately Played": 0.6, "Heavily Played": 0.35, "Damaged": 0.15 };

  /* The share of the near-mint price this card is worth: 1 for near mint, blank or graded. */
  function factor(card) {
    if (card && card.grader && card.grader !== "Raw") return 1;
    const f = FACTORS[(card && card.condition) || "Near Mint"];
    return typeof f === "number" ? f : 1;
  }

  /* A logged price as this card's value (in the price's own currency): automatic prices adjusted. */
  function adjust(card, price) {
    if (!price || typeof price.amount !== "number") return null;
    return price.auto ? Math.round(price.amount * factor(card) * 100) / 100 : price.amount;
  }

  root.BinderCondition = { FACTORS, factor, adjust };
})(typeof window !== "undefined" ? window : globalThis);
