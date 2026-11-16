/* Find a card → Any card: a card from the card database (src/application/catalog/show-any-card.ts)
   as the page shows it and adds it. Its number as printed ("4/102"), which printing to show first (and which once prices arrive),
   and the new card's fields for Add to a binder (and the whole card for the next empty pocket of the binder chosen, the open one to start with).
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

  /* The printing to show once prices arrive: the one picked meanwhile, if it's still there; else the first priced. */
  function printingAfterPrices(printings, pi, picked) {
    return picked && Number.isInteger(pi) && pi >= 0 && pi < (printings || []).length ? pi : firstPrinting(printings);
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

  /* The card Add to <binder> saves: draftFields plus what the new card form starts with and sends,
     at loc ({binderId, page, slot}; a display case has no page or pocket). */
  function binderCard(card, printing, loc, owner, at) {
    return {
      ...draftFields(card, printing),
      language: "English", condition: "Near Mint", grader: "Raw", grade: "", notes: "",
      status: "binder", owner, placeholder: false, imageId: null, prices: [],
      binderId: loc.binderId, page: loc.page ?? null, slot: loc.slot ?? null,
      createdAt: at, updatedAt: at,
    };
  }

  /* The binder Add puts the card in: the one open (by id, among binders), unless Pricing or the Selling view
     is on top of it, or the open tab is Not in a binder, Sales or Watchlist (ids "__loose", "__sales", "__watch"). Else null. */
  function addTarget(binders, openId, overlayOpen) {
    if (overlayOpen || !openId || String(openId).startsWith("__")) return null;
    return (binders || []).find(b => b.id === openId) || null;
  }

  /* The binder Add puts the card in: the one chosen in Any card's chooser, if it's still there; else the one open (addTarget).
     "" (New card form) or none: null, and Add opens the new card form. */
  function addTo(binders, openId, overlayOpen, chosenId) {
    if (typeof chosenId === "string" && chosenId) {
      const b = (binders || []).find(x => x.id === chosenId);
      if (b) return b;
    }
    return addTarget(binders, openId, overlayOpen);
  }

  root.BinderLookup = { cardNo, firstPrinting, printingAfterPrices, draftFields, binderCard, addTarget, addTo };
})(typeof window !== "undefined" ? window : globalThis);
