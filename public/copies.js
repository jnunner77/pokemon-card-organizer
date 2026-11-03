/* Copies of one card for Find a card and the Trade picker: which cards count as the same one, and the
   "· 4 copies" note. A plain script: the page uses window.BinderCopies, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* `deps`: same(a, b) (the same printing, variant and language), gradeLabel(grader, grade), held(card)
     (not sold or traded) and owned(card) (held, and not a placeholder or a watchlist entry).
     Returns the `same(a, b)` for BinderSearch: also the same grade, and both held or both not, both owned or both not. */
  function sameCopy(deps) {
    const g = c => deps.gradeLabel(c.grader, c.grade);
    return (a, b) => deps.same(a, b) && g(a) === g(b) && deps.held(a) === deps.held(b) && deps.owned(a) === deps.owned(b);
  }

  const note = n => n > 1 ? ` · ${n} copies` : "";

  root.BinderCopies = { sameCopy, note };
})(typeof window !== "undefined" ? window : globalThis);
