/* A new card's photo can be picked before the card is added and be ready after: which card it goes
   on. Loaded before app.js; tested in tests/newcard.test.ts. */
(function () {
  /**
   * Where a finished photo goes. `target` is the card it was picked for ("__new" for a card being
   * added), `key` the new card's draft key then; `sel` and `draftKey` are what's open now, and
   * `added` maps each added draft's key to its card's id. Returns "draft" (the same new card is still
   * open), a card id (it was added meanwhile), or "gone" (that new card was closed without adding it).
   */
  function photoTarget({ target, key, sel, draftKey, added }) {
    if (target !== "__new") return target;
    if (sel === "__new" && draftKey && (!key || key === draftKey)) return "draft";
    if (key && added && added[key]) return added[key];
    return "gone";
  }
  window.BinderNewCard = { photoTarget };
})();
