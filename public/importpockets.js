/* CSV import: which pocket each row goes in. A pocket holds copies of one card (stack.js), so rows
   for the same card with the same page and pocket go in that pocket together (an export of a stacked
   pocket imports back the same way). A row for a different card than what is in the pocket follows
   the person's choice: replace what is there, use the next empty pocket, or flag an error. Rows
   with no page and pocket go in the next empty pockets.
   A plain script: the page uses window.BinderImportPockets, and the tests load it the same way. */
(function (root) {
  "use strict";

  const keyOf = (r) => r.bkey + "|" + r.page + "|" + r.slot;
  const nameOf = (c) => (c && c.name) || "Unnamed card";

  /* rows: the checked rows ({line, errors, warns, data, prices, bkey, page, slot, auto, inCase}), in
     file order; rows with errors are left alone. existing: Map of "bkey|page|slot" → the ledger's
     cards in that pocket, top copy first. o: {taken: "replace" | "next" | "error", pocketsFor(bkey):
     the binder's pockets per page}. same(a, b): whether two cards are the same card.
     Changes the rows (page and slot for auto rows, replaceId/replaceName/replaceOld for the ledger card
     a row overwrites, replaced for a row dropped for a later one, errors and warnings) and returns them. */
  function assign(rows, existing, o, same) {
    const ok = (r) => !r.errors.length;
    const live = rows.filter((r) => ok(r) && r.bkey && !r.auto && !r.inCase);

    // 1. Within the file: rows for the same card in one pocket go together; a different card follows the choice.
    const groups = new Map();
    for (const r of live) {
      const k = keyOf(r), g = groups.get(k) || [];
      groups.set(k, g);
      if (!g.length || same(g[0].data, r.data)) { g.push(r); continue; }
      const first = g[0];
      if (o.taken === "replace") {
        for (const prev of g) { prev.errors.push(`Replaced by row ${r.line} (${r.data.name}), which uses the same page and pocket later in the file.`); prev.replaced = true; }
        g.length = 0; g.push(r);
      } else if (o.taken === "next") {
        r.auto = true; r.home = k; r.warns.push(`Page ${r.page}, pocket ${r.slot} is taken by row ${first.line} (${first.data.name}), so this card goes in the next empty pocket.`);
      } else r.errors.push(`Page ${r.page}, pocket ${r.slot} is already taken by row ${first.line} (${first.data.name}).`);
    }

    // 2. Against the ledger's copies in the pocket.
    for (const [k, g0] of groups) {
      const E = existing.get(k) || [], g = g0.filter((r) => ok(r) && !r.replaced && !r.auto);
      if (!E.length || !g.length) continue;
      const first = g[0], where = `Page ${first.page}, pocket ${first.slot}`;
      const sameAsE = E.every((e) => same(first.data, e));
      if (o.taken === "replace") {
        if (!sameAsE && g.length < E.length) {
          const last = g[g.length - 1];
          for (const r of g) r.errors.push(r === last ? `${where} has ${E.length} copies of ${nameOf(E[0])}; give each one a row, or use another pocket.` : `Not imported: row ${last.line} can't replace every copy in ${where.toLowerCase()}.`);
          continue;
        }
        g.forEach((r, i) => {
          const old = E[i];
          if (!old) return; // more rows than copies: the rest are added as copies
          r.replaceId = old.id; r.replaceName = nameOf(old); r.replaceOld = old;
          r.warns.push(`Replaces ${r.replaceName} in page ${r.page}, pocket ${r.slot}. Its details and price log are overwritten.`);
        });
        continue;
      }
      for (const r of g) {
        if (sameAsE) r.warns.push(`Added as another copy of ${nameOf(E[0])}, already in page ${r.page}, pocket ${r.slot}.`);
        else if (o.taken === "next") { r.auto = true; r.home = k; r.warns.push(`Page ${r.page}, pocket ${r.slot} is taken by ${nameOf(E[0])} (already in your ledger), so this card goes in the next empty pocket.`); }
        else r.errors.push(`${where} is already taken by ${nameOf(E[0])} (already in your ledger).`);
      }
    }

    // 3. Rows with no pocket (or sent on from a taken one) go in the next empty pockets; copies sent on from one pocket stay together.
    const busy = new Set([...existing.keys()]);
    for (const r of rows) if (ok(r) && r.bkey && !r.auto && !r.inCase && r.page && r.slot) busy.add(keyOf(r));
    const sentOn = [];
    for (const r of rows) {
      if (!ok(r) || !r.bkey || !r.auto || r.inCase) continue;
      const mate = r.home ? sentOn.find((m) => m.home === r.home && same(m.data, r.data)) : undefined;
      if (mate) { r.page = mate.page; r.slot = mate.slot; continue; }
      const n = o.pocketsFor(r.bkey);
      let p = 1, s = 1;
      while (busy.has(r.bkey + "|" + p + "|" + s)) { if (++s > n) { s = 1; p++; } }
      r.page = p; r.slot = s; busy.add(r.bkey + "|" + p + "|" + s);
      if (r.home) sentOn.push(r);
    }
    return rows;
  }

  root.BinderImportPockets = { assign };
})(typeof window !== "undefined" ? window : globalThis);
