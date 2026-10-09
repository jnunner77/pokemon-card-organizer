/* The Table editor: every card as a row of its details, edited in the cells like a spreadsheet.
   This file holds the columns, the header filters, sorting and checking an edit; the page draws it.
   Picture, value, paid and the price match are columns too, but hidden until turned on.

   ctx (from the page) gives what the cards don't hold themselves:
     options: {language, condition, grader, status, owner}: each a list of values or [value, label]
     location(c), binder(c), locKey(c): where the card is, its binder's name, and its place in order
     value(c), paid(c): CAD or null; money(n): formatted
     picture(c): "Official image", "Your photo" or ""; match(c): {group, text} for its price match

   Filters are {column key: text}. A dropdown filter's text is "=" and the value ("=" alone: blank);
   a text filter matches cells containing it, and (blank) / (not blank) match empty or filled cells;
   a number filter also takes >, >=, <, <= and from-to ranges ("10-20").
   A plain script: the page uses window.BinderTable, and the tests load it the same way. */
(function (root) {
  "use strict";

  const COLUMNS = [
    { k: "name", h: "Card", edit: "text", max: 200, required: true, filter: "text", always: true },
    { k: "set", h: "Set", edit: "text", max: 200, suggest: true, filter: "pick" },
    { k: "setCode", h: "Set code", edit: "text", max: 40, suggest: true, filter: "pick", mono: true },
    { k: "number", h: "Number", edit: "text", max: 40, filter: "text", mono: true },
    { k: "rarity", h: "Rarity", edit: "text", max: 100, suggest: true, filter: "pick" },
    { k: "variant", h: "Variant / stamp", edit: "text", max: 200, suggest: true, filter: "pick" },
    { k: "language", h: "Language", edit: "select", def: "English", filter: "pick" },
    { k: "condition", h: "Condition", edit: "select", def: "Near Mint", filter: "pick" },
    { k: "grader", h: "Graded by", edit: "select", def: "Raw", filter: "pick" },
    { k: "grade", h: "Grade", edit: "text", max: 20, filter: "pick", mono: true },
    { k: "artist", h: "Illustrator", edit: "text", max: 200, suggest: true, filter: "pick" },
    { k: "status", h: "Status", edit: "select", def: "binder", filter: "pick" },
    { k: "owner", h: "Owner", edit: "select", def: "", filter: "pick" },
    { k: "placeholder", h: "Placeholder", edit: "bool", filter: "pick" },
    { k: "notes", h: "Notes", edit: "long", max: 10000, filter: "text" },
    { k: "location", h: "Location", filter: "pick", get: (c, x) => x.location(c), group: (c, x) => x.binder(c), sort: (c, x) => x.locKey(c) },
    { k: "released", h: "Released", filter: "pick", mono: true, group: c => (/^\d{4}/.test(c.released || "") ? c.released.slice(0, 4) : "") },
    { k: "picture", h: "Picture", optional: true, filter: "pick", get: (c, x) => x.picture(c) },
    { k: "value", h: "Value", optional: true, num: true, filter: "num", get: (c, x) => x.value(c) },
    { k: "paid", h: "Paid", optional: true, num: true, filter: "num", get: (c, x) => x.paid(c) },
    { k: "match", h: "Price match", optional: true, filter: "pick", get: (c, x) => x.match(c).text, group: (c, x) => x.match(c).group },
  ];
  const BY = Object.fromEntries(COLUMNS.map(c => [c.k, c]));
  const BLANK = "(blank)", FILLED = "(not blank)";

  const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const pairs = list => (list || []).map(o => (Array.isArray(o) ? o : [o, o]));
  const cmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  const plain = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // the page's location keys sort as plain text

  /* which columns show: every one but the optional ones, unless pref says otherwise; name always */
  function visible(pref) {
    pref = pref || {};
    return COLUMNS.filter(c => c.always || (c.k in pref ? !!pref[c.k] : !c.optional));
  }

  /* the cell's value: what's stored (or the drawer's default), or what the page works out */
  function raw(c, col, ctx) {
    if (col.get) return col.get(c, ctx);
    if (col.edit === "bool") return !!c[col.k];
    const v = c[col.k];
    return v == null || v === "" ? (col.def ?? "") : v;
  }

  /* how a value reads: a dropdown's label, Yes / No, money */
  function label(col, v, ctx) {
    if (col.edit === "bool") return v === true || v === "Yes" ? "Yes" : "No";
    if (col.num) return v == null ? "" : ctx.money(v);
    if (col.edit === "select") { const o = pairs(ctx.options[col.k]).find(([val]) => String(val) === String(v)); if (o) return o[1]; }
    return String(v ?? "");
  }

  /* what a dropdown filter groups the card under */
  function group(c, col, ctx) {
    if (col.group) return String(col.group(c, ctx) ?? "");
    if (col.edit === "bool") return raw(c, col, ctx) ? "Yes" : "No";
    return String(raw(c, col, ctx) ?? "");
  }

  /* a dropdown filter's choices from these cards: [{v, label, n}], blank last */
  function choices(cards, col, ctx) {
    const n = new Map();
    for (const c of cards) { const g = group(c, col, ctx); n.set(g, (n.get(g) || 0) + 1); }
    const order = col.edit === "select" ? pairs(ctx.options[col.k]).map(([v]) => String(v)) : null;
    const keys = [...n.keys()].sort((a, b) => {
      if (!a !== !b) return a ? -1 : 1;
      if (order) { const i = order.indexOf(a), j = order.indexOf(b); if (i !== j) return (i < 0 ? 1e9 : i) - (j < 0 ? 1e9 : j); }
      return cmp(a, b);
    });
    return keys.map(v => ({ v, label: (col.edit === "select" ? label(col, v, ctx) : v) || BLANK, n: n.get(v) }));
  }

  /* a number filter: >10, <=5, 10-20, or a number */
  function numTest(f) {
    const s = f.replace(/[$,\s]/g, "");
    let m = s.match(/^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)$/);
    if (m) { const n = +m[2]; return { ">": v => v > n, ">=": v => v >= n, "<": v => v < n, "<=": v => v <= n }[m[1]] || (v => Math.abs(v - n) < 0.005); }
    m = s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (m) { const lo = Math.min(+m[1], +m[2]), hi = Math.max(+m[1], +m[2]); return v => v >= lo && v <= hi; }
    return null;
  }

  function active(filters) {
    return Object.entries(filters || {}).filter(([k, f]) => BY[k] && typeof f === "string" && f !== "");
  }
  const count = filters => active(filters).length;

  /* does the card show with these filters? */
  function matches(c, filters, ctx) {
    for (const [k, f] of active(filters)) {
      const col = BY[k];
      if (col.filter === "pick") { if (group(c, col, ctx) !== f.slice(1)) return false; continue; }
      const v = raw(c, col, ctx), empty = v == null || String(v).trim() === "";
      const q = norm(f);
      if (q === BLANK) { if (!empty) return false; continue; }
      if (q === FILLED) { if (empty) return false; continue; }
      if (col.filter === "num") {
        const t = numTest(f);
        if (t) { if (empty || !t(Number(v))) return false; continue; }
      }
      if (!norm(label(col, v, ctx)).includes(q)) return false;
    }
    return true;
  }

  /* the cards in order of sort {k, d} (1 up, -1 down); blanks last either way, then by location */
  function sort(cards, s, ctx) {
    const col = BY[s && s.k] || BY.location, d = s && s.d < 0 ? -1 : 1;
    const key = c => (col.sort ? col.sort(c, ctx) : col.num ? raw(c, col, ctx) : label(col, raw(c, col, ctx), ctx));
    const keyed = cards.map(c => ({ c, v: key(c), at: ctx.locKey(c) }));
    const blank = v => v == null || v === "";
    keyed.sort((a, b) => {
      if (blank(a.v) !== blank(b.v)) return blank(a.v) ? 1 : -1;
      const x = blank(a.v) ? 0 : col.num ? a.v - b.v : col.sort ? plain(a.v, b.v) : cmp(a.v, b.v);
      return x * d || plain(a.at, b.at) || cmp(a.c.name || "", b.c.name || "");
    });
    return keyed.map(x => x.c);
  }

  /* an edit to check before it's saved: {value} or {error} */
  function parse(col, input, ctx) {
    if (!col.edit) return { error: `${col.h} can't be changed here.` };
    if (col.edit === "bool") return { value: input === true || input === "true" };
    const v = String(input ?? "").trim();
    if (col.edit === "select") {
      if (!pairs(ctx.options[col.k]).some(([val]) => String(val) === v)) return { error: `${v || "Blank"} isn't one of the ${col.h.toLowerCase()} choices.` };
      return { value: v };
    }
    if (col.required && !v) return { error: `A card needs a ${col.h === "Card" ? "name" : col.h.toLowerCase()}.` };
    if (col.max && v.length > col.max) return { error: `${col.h} is at most ${col.max} characters.` };
    return { value: v };
  }

  /* is value different from what the card has now? */
  function changed(c, col, value) {
    if (col.edit === "bool") return !!c[col.k] !== !!value;
    const now = c[col.k] == null || c[col.k] === "" ? (col.edit === "select" ? (col.def ?? "") : "") : String(c[col.k]);
    return now !== value;
  }

  root.BinderTable = { COLUMNS, BY, BLANK, FILLED, visible, raw, label, group, choices, matches, count, sort, parse, changed };
})(typeof window !== "undefined" ? window : globalThis);
