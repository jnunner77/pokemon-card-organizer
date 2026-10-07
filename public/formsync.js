/* The open card drawer when the card changes elsewhere (choosing a price-site product fills in its
   set or variant, details are looked up, another device saves it): a text field the person hasn't
   edited since the drawer showed it takes the card's new value; one they have edited keeps their
   text, so Save neither loses it nor puts back the old value.
   A plain script: the page uses window.BinderFormSync, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* The text fields that follow the card. */
  const KEYS = ["name", "set", "setCode", "number", "rarity", "variant", "grade", "artist", "notes"];

  /* fields: the form's fields as {name, value, defaultValue} (defaultValue: what the drawer showed);
     card: the card now. Returns {name: value} for each field to change. */
  function updates(fields, card) {
    const out = {};
    for (const f of fields) {
      if (!KEYS.includes(f.name) || f.value !== f.defaultValue) continue;
      const now = String(card[f.name] ?? "");
      if (now !== f.value) out[f.name] = now;
    }
    return out;
  }

  root.BinderFormSync = { KEYS, updates };
})(typeof window !== "undefined" ? window : globalThis);
