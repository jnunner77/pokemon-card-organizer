/* Back closes what's open over the page (the Pricing or Selling view, Card details, the guest page's
   full screen) instead of leaving it. Each open layer has one extra history entry, so the phone's
   Back gesture (or the browser's Back button) closes the top layer first. Closing a layer any other
   way (✕, the scrim, Escape, "Back to binders") takes its entry back off, so the next Back goes
   where it did before it opened. Opening a layer that's already open adds nothing.
   Entries only count how many layers are open (state.backDepth); the layers themselves are kept
   here, in the order they opened.
   A plain script: the page uses window.BackClose, and the tests load it the same way. */
(function (root) {
  "use strict";

  const KEY = "backDepth", OLD = "cardDetails";
  const depthOf = s => (s && s[KEY]) || 0;
  const withDepth = (s, d) => { const o = { ...(s || {}) }; delete o[OLD]; if (d) o[KEY] = d; else delete o[KEY]; return o; };

  /* history: window.history (or a stand-in). onBack (optional): a single layer's close, for pages
     with one layer, which then use sync(isOpen) directly; others call layer() once per layer. */
  function create(history, onBack) {
    const open = []; // the open layers, oldest first: {name, onBack}
    let pushed = 0, leaving = false; // our entries above the page's own; waiting for our own go()
    // A reload keeps the entries but not what was open: forget them, so the next layer adds its own.
    if (history.state && (history.state[KEY] || history.state[OLD])) history.replaceState(withDepth(history.state, 0), "");

    // Make the entries match the open layers. Once a go() is under way, wait for its popstate.
    function settle() {
      if (leaving) return;
      if (pushed > open.length) { leaving = true; const n = pushed - open.length; pushed = open.length; history.go(-n); }
      else while (pushed < open.length) history.pushState(withDepth(history.state, ++pushed), "");
    }

    /* name: a layer's name; close: closes it when Back is pressed */
    function layer(name, close) {
      const me = { name, onBack: close };
      return {
        /* call whenever the layer is drawn: is it showing? */
        sync(isOpen) {
          const i = open.indexOf(me);
          if (isOpen === (i >= 0)) return;
          if (isOpen) open.push(me); else open.splice(i, 1);
          settle();
        },
      };
    }

    /* call from the window's popstate event with event.state */
    function popstate(state) {
      if (leaving) { leaving = false; settle(); return; } // our own go(); add any layer opened since
      const d = depthOf(state);
      if (d < pushed) {
        // Back: close the layers above this entry, newest first
        pushed = d;
        open.splice(d).reverse().forEach(l => l.onBack());
        settle();
      } else if (d > pushed) history.replaceState(withDepth(state, pushed), ""); // Forward into a closed layer's entry
    }

    const single = onBack ? layer("default", onBack) : null;
    return { layer, popstate, sync: single ? single.sync : undefined };
  }

  root.BackClose = { create };
})(typeof window !== "undefined" ? window : globalThis);
