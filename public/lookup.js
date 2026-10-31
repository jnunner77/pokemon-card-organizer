/* Find a card → Any card: a card from the card database (src/application/catalog/show-any-card.ts)
   as the page shows it and adds it. Its number as printed ("4/102"), which printing to show first,
   and the new card's fields for Add to a binder (and, from inside a binder, the whole card for its next empty pocket).
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

  root.BinderLookup = { cardNo, firstPrinting, draftFields, binderCard, addTarget };
})(typeof window !== "undefined" ? window : globalThis);
