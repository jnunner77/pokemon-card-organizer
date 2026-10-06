/* Back closes Card details. While the drawer is open the page has one extra history entry, so the
   phone's Back gesture (or the browser's Back button) closes the drawer instead of leaving the page.
   Closing it any other way (✕, the scrim, Escape) takes that entry back off, so the next Back goes
   where it did before the card was opened. Opening another card, or saving a new one, while the
   drawer is open adds nothing.
   A plain script: the page uses window.BackClose, and the tests load it the same way. */
(function (root) {
  "use strict";

  const KEY = "cardDetails";
  const without = s => { const o = { ...(s || {}) }; delete o[KEY]; return o; };

  /* history: window.history (or a stand-in); onBack: closes the drawer when Back is pressed */
  function create(history, onBack) {
    let open = false, leaving = 0;
    // A reload keeps the entry but not the drawer: forget it, so the next card adds its own.
    if (history.state && history.state[KEY]) history.replaceState(without(history.state), "");

    /* call whenever the drawer is drawn: is it showing a card? */
    function sync(isOpen) {
      if (isOpen === open) return;
      open = isOpen;
      if (isOpen) { if (!leaving) history.pushState({ ...(history.state || {}), [KEY]: true }, ""); }
      else { leaving++; history.back(); }
    }

    /* call from the window's popstate event with event.state */
    function popstate(state) {
      if (leaving) {
        // our own back() from closing the drawer; a card opened since then needs its entry again
        leaving--;
        if (open && !leaving) history.pushState({ ...(history.state || {}), [KEY]: true }, "");
        return;
      }
      const has = !!(state && state[KEY]);
      if (open && !has) { open = false; onBack(); }
      else if (!open && has) history.replaceState(without(state), ""); // Forward into a closed drawer's entry
    }

    return { sync, popstate };
  }

  root.BackClose = { create };
})(typeof window !== "undefined" ? window : globalThis);
