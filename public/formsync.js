/* The open card drawer when the card changes elsewhere (logging a sale marks it sold, choosing a
   price-site product fills in its set or variant, details are looked up, another device saves it):
   a field or dropdown the person hasn't changed since the drawer showed it takes the card's new
   value; one they have changed keeps their choice, so Save neither loses it nor puts back the old value.
   A plain script: the page uses window.BinderFormSync, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* The text fields that follow the card. */
  const KEYS = ["name", "set", "setCode", "number", "rarity", "variant", "grade", "artist", "notes"];
  /* The dropdowns that follow the card, with what each shows for a card without a value. */
  const SELECTS = { language: "English", condition: "Near Mint", grader: "Raw", status: "binder", owner: "" };

  /* fields: the form's fields as {name, value, defaultValue} (defaultValue: what the drawer showed;
     for a dropdown, the option it showed as chosen); card: the card now. Returns {name: value} for
     each field to change. */
  function updates(fields, card) {
    const out = {};
    for (const f of fields) {
      const select = Object.prototype.hasOwnProperty.call(SELECTS, f.name);
      if ((!select && !KEYS.includes(f.name)) || f.value !== f.defaultValue) continue;
      const now = select ? String(card[f.name] || SELECTS[f.name]) : String(card[f.name] ?? "");
      if (now !== f.value) out[f.name] = now;
    }
    return out;
  }

  root.BinderFormSync = { KEYS, SELECTS, updates };
})(typeof window !== "undefined" ? window : globalThis);
