/* A card's price entries changed one by one (server/priceops.ts): what the page worked out from its
   copy of the list, sent as the entries to add, change and remove, so the server applies them to
   the list it has now and an entry the daily update or someone else added meanwhile is kept. */
(function () {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /* The changes that turn `before` into `after`, matched by each entry's id. */
  function diff(before, after) {
    const was = new Map((before || []).filter(e => e && e.id).map(e => [e.id, e]));
    const now = new Set();
    const add = [], update = [];
    for (const e of after || []) {
      if (!e || !e.id) continue;
      now.add(e.id);
      const old = was.get(e.id);
      if (!old) add.push(e);
      else if (!same(old, e)) update.push(e);
    }
    const remove = [...was.keys()].filter(id => !now.has(id));
    return { add, update, remove };
  }
  window.BinderPriceOps = { diff };
})();
