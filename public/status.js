/* Quick status change (press and hold a card's status, or Status in the selection bar): which of
   the chosen cards take the new status, and which stay as they are and why.
   A plain script: the page uses window.BinderStatus, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* how the toast says what the cards are now, and what they already were */
  const DONE = { binder: "back in the binder", listed: "listed for sale", grading: "out for grading", sold: "sold", traded: "traded" };
  const ALREADY = { ...DONE, binder: "in the binder" };
  /* a placeholder holds a pocket for a card not owned yet: it can't be listed, graded, sold or traded */
  const NEEDS_CARD = ["listed", "grading", "sold", "traded"];

  const statusOf = c => c.status || "binder";

  /* The cards that change (ids), and how many stay as they are: already that status, placeholders,
     and cards sold with Quick sell (they keep their sale; undoing it puts them back). Sold is
     recorded by Quick sell, so `change` is then the cards to open it for: a traded card can't be sold. */
  function plan(cards, status) {
    const out = { change: [], same: 0, placeholder: 0, quickSold: 0, traded: 0 };
    for (const c of cards) {
      if (!c) continue;
      if (c.sale && statusOf(c) === "sold") out.quickSold++;
      else if (statusOf(c) === status) out.same++;
      else if (c.placeholder && NEEDS_CARD.includes(status)) out.placeholder++;
      else if (status === "sold" && statusOf(c) === "traded") out.traded++;
      else out.change.push(c.id);
    }
    return out;
  }

  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

  /* why some cards weren't changed, or "" when every card was */
  function leftAlone(p) {
    const why = [];
    if (p.same) why.push(n(p.same, "was already", "were already") + " " + (ALREADY[p.status] || "that"));
    if (p.placeholder) why.push(n(p.placeholder, "is a placeholder", "are placeholders"));
    if (p.traded) why.push(n(p.traded, "was traded", "were traded"));
    if (p.quickSold) why.push(n(p.quickSold, "was sold with Quick sell (undo the sale to change it)", "were sold with Quick sell (undo the sale to change them)"));
    return why.join("; ");
  }

  /* the toast after saving: "3 cards listed for sale" and why any weren't */
  function summary(p, saved) {
    const head = saved ? `${n(saved, "card", "cards")} ${DONE[p.status] || "changed"}` : "Nothing changed";
    const tail = leftAlone(p);
    return tail ? `${head}. Left as they were: ${tail}.` : head;
  }

  /* the status every card has, or "" when they differ */
  function shared(cards) {
    const s = new Set(cards.filter(Boolean).map(statusOf));
    return s.size === 1 ? [...s][0] : "";
  }

  root.BinderStatus = { plan: (cards, status) => ({ ...plan(cards, status), status }), summary, leftAlone, shared, statusOf };
})(typeof window !== "undefined" ? window : globalThis);
