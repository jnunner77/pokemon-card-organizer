/* Whose card it is, shown as a dot in the corner of a pocket: red for Justin, green for Maiya, half
   red and half blank for Both (Megan and Justin), none for Megan or when no owner is set. The owners
   are the fixed list in src/domain/cards/card-fields.ts (mirrored by OWNERS in app.js).
   A plain script: the page uses window.BinderOwner, and the tests load it the same way. */
(function (root) {
  "use strict";

  const DOTS = { justin: "red", maiya: "green", both: "half" };
  const LABELS = { justin: "Justin's card", maiya: "Maiya's card", both: "Megan and Justin's card" };
  const NAMES = { megan: "Megan's", justin: "Justin's", maiya: "Maiya's", both: "Megan and Justin's" };

  const key = (owner) => (typeof owner === "string" ? owner.trim().toLowerCase() : "");
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* The dot's look: "red", "green", "half", or "" for no dot */
  const dotOf = (owner) => { const k = key(owner); return has(DOTS, k) ? DOTS[k] : ""; };
  /* The dot's hover text: "Justin's card", or "" for no dot */
  const dotTitle = (owner) => { const k = key(owner); return has(LABELS, k) ? LABELS[k] : ""; };
  /* The owner for a screen reader: "Megan's", "Megan and Justin's", or "" when unset */
  const ownerLabel = (owner) => { const k = key(owner); return has(NAMES, k) ? NAMES[k] : ""; };

  root.BinderOwner = { dotOf, dotTitle, ownerLabel };
})(typeof window !== "undefined" ? window : globalThis);
