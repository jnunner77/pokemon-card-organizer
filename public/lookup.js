/* Find a card → Any card: a card from the card database (server/lookup.ts) as the page shows it and
   adds it. Its number as printed ("4/102"), which printing to show first, and the new card's fields
   for Add to a binder.
   A plain script: the page uses window.BinderLookup, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* "4" of 102 → "4/102"; a promo's "SWSH050", or a card with no set size, as it is. */
  const cardNo = c => (c.total && /^\d+$/.test(String(c.number)) ? `${c.number}/${c.total}` : String(c.number ?? ""));

  /* The printing to show first: the first one with a price (the regular card comes first), else the first. */
  function firstPrinting(printings) {
    const i = (printings || []).findIndex(p => p && p.price);
    return i < 0 ? 0 : i;
  }

  /* The new card's fields for Add to a binder: the card, as the printing chosen. */
  function draftFields(card, printing) {
    return {
      name: card.name || "",
      set: card.set || "",
      setCode: card.setCode || "",
      number: cardNo(card),
      rarity: card.rarity || "",
      variant: (printing && printing.variant) || "",
      artist: card.artist || "",
    };
  }

  root.BinderLookup = { cardNo, firstPrinting, draftFields };
})(typeof window !== "undefined" ? window : globalThis);
