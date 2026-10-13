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

  /* What a form field showed when the drawer drew it (or last saved it): a dropdown's is the option
     drawn as chosen (the first, when none is). */
  function shownValue(el) {
    if (el.tagName !== "SELECT") return el.defaultValue;
    const opts = Array.from(el.options);
    const o = opts.find((x) => x.defaultSelected) || opts[0];
    return o ? o.value : "";
  }

  /* Marks a field's current value as what the drawer shows, so it counts as unchanged. */
  function markShown(el) {
    if (el.tagName === "SELECT") for (const o of Array.from(el.options)) o.defaultSelected = o.selected;
    else if (el.type === "checkbox" || el.type === "radio") el.defaultChecked = el.checked;
    else if ("defaultValue" in el) el.defaultValue = el.value;
  }

  /* Shows the card's value in a field, as unchanged. A dropdown without it among its choices stays
     as it is (returns false). */
  function show(el, value) {
    if (el.tagName === "SELECT") {
      const opts = Array.from(el.options);
      const hit = opts.find((o) => o.value === value);
      if (!hit) return false;
      for (const o of opts) o.selected = o.defaultSelected = o === hit;
    } else el.defaultValue = value;
    el.value = value;
    return true;
  }

  /* Whether the person changed any of these fields since the drawer drew them (or last saved
     them): a box ticked or unticked, or a value that isn't what the field showed. Search boxes and
     file pickers hold nothing of the card's. */
  function edited(elements) {
    return Array.from(elements).some((el) => {
      if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.readOnly || el.disabled || /^(button|submit|reset|hidden|file|search)$/.test(el.type)) return false;
      if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
      return el.value !== shownValue(el);
    });
  }

  /* Whether closing the open drawer would lose something: a field changed in it (the card's details,
     a price being added or edited, a move being set up), or, for a card not added yet, its photo.
     fields: the drawer's fields; draft: the new card being added, or null. */
  function unsaved(fields, draft) {
    return edited(fields) || !!(draft && draft.imageId);
  }

  root.BinderFormSync = { KEYS, SELECTS, updates, shownValue, markShown, show, edited, unsaved };
})(typeof window !== "undefined" ? window : globalThis);
