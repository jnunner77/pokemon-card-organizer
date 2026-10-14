/* Bulk buy: several cards bought together (16 cards at a card show), each typed by its name and
   number, matched to the placeholders holding their pockets, with the tax shared across them.
   - A row matches the placeholders with its number (51 matches 51/162 and 051/162; 51/162 doesn't
     match 51/165) and its name (case, accents and spacing don't matter; "pikachu" finds
     "Pikachu ex" when no card is called just Pikachu).
   - Placeholders of the same printing (set, number, variant, language) are interchangeable: the
     first free one is taken. Different printings (a reverse holo and a Poké Ball pattern) are for
     the person to pick. Two rows for the same card take two different placeholders.
   - The tax is split in proportion to the prices, in cents, adding up to the tax exactly.
   A plain script: the page uses window.BinderBulkBuy, and the tests load it the same way. */
(function (root) {
  "use strict";

  const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’`.]/g, "").replace(/[^a-z0-9/]+/g, " ").trim();
  const words = s => norm(s).split(" ").filter(Boolean);
  const compact = s => norm(s).replace(/[ /]/g, "");
  const held = c => !["sold", "traded"].includes(c.status);

  /* "051/162" → {part:"51", total:"162"}; "TG10/TG30" → {part:"tg10", total:"tg30"}; "" → null */
  function numberKey(s) {
    const n = norm(s).replace(/\s+/g, "");
    if (!n) return null;
    const [a, b] = n.split("/");
    const lead = x => (/^\d+$/.test(x) ? String(Number(x)) : x);
    return { part: lead(a || ""), total: b ? lead(b) : "" };
  }
  function numberMatches(typed, cardNumber) {
    const t = numberKey(typed), c = numberKey(cardNumber);
    if (!t || !c || !t.part || t.part !== c.part) return false;
    return !t.total || !c.total || t.total === c.total;
  }

  /* 2: the same name ("Arceus V Star" is "Arceus VSTAR"); 1: every word typed starts a word of the
     card's name ("pikachu" for "Pikachu ex"); 0: no match. */
  function nameScore(typed, cardName) {
    const t = words(typed);
    if (!t.length) return 0;
    if (compact(typed) === compact(cardName)) return 2;
    const n = words(cardName);
    return t.every(w => n.some(x => x.startsWith(w))) ? 1 : 0;
  }

  /* Placeholders of one printing are the same card to whoever bought it. */
  const printingKey = c => { const n = numberKey(c.number); return [c.set, c.setCode, n ? `${n.part}/${n.total}` : "", c.variant, c.language || "English"].map(norm).join("|"); };

  /* Every card still held, by its number (part before the "/"), each normalised once. Kept for the
     same list of cards (the page gets a new list with every change), so typing doesn't redo it. */
  const indexes = new WeakMap();
  function index(cards) {
    if (indexes.has(cards)) return indexes.get(cards);
    const by = new Map();
    for (const c of cards) {
      if (!held(c)) continue;
      const n = numberKey(c.number);
      if (!n || !n.part) continue;
      if (!by.has(n.part)) by.set(n.part, []);
      by.get(n.part).push({ card: c, total: n.total, compact: compact(c.name), words: words(c.name) });
    }
    indexes.set(cards, by);
    return by;
  }

  /* The cards a row could be: its best name matches with its number. */
  function found(row, by) {
    const t = numberKey(row.number), typed = words(row.name), tc = compact(row.name);
    let best = 0, out = [];
    for (const e of by.get(t.part) || []) {
      if (t.total && e.total && t.total !== e.total) continue;
      const s = tc === e.compact ? 2 : typed.every(w => e.words.some(x => x.startsWith(w))) ? 1 : 0;
      if (!s || s < best) continue;
      if (s > best) { best = s; out = []; }
      out.push(e.card);
    }
    return out;
  }

  /**
   * Each row's match. rows: [{name, number, pick?}] where pick is a printing key the person chose.
   * cards: every card. options.order(card): where it sits, smaller first (the first free pocket is
   * filled first). Returns, per row, {status, cardId, printings, pick}:
   *   blank       nothing typed (the row is ignored)
   *   incomplete  the name or the number (or both, with a price typed) still missing
   *   match       cardId is the placeholder it fills
   *   choose      several printings fit: printings [{key, card, free}] to pick from
   *   none        no placeholder: reason "missing" (no such card), "owned" (only cards you have
   *               already) or "taken" (its placeholders are used by the rows above)
   */
  function match(rows, cards, options) {
    const order = (options && options.order) || (() => "");
    const byOrder = (a, b) => String(order(a)).localeCompare(String(order(b)));
    const taken = new Set();
    let by = null;
    return (rows || []).map(row => {
      const name = String(row.name ?? "").trim(), number = String(row.number ?? "").trim();
      if (!name && !number) return { status: String(row.price ?? "").trim() ? "incomplete" : "blank" };
      if (!name || !numberKey(number)) return { status: "incomplete" };
      if (!by) by = index(cards || []);
      const all = found({ name, number }, by);
      const ph = all.filter(c => c.placeholder).sort(byOrder);
      if (!ph.length) return { status: "none", reason: all.length ? "owned" : "missing" };
      const free = ph.filter(c => !taken.has(c.id));
      if (!free.length) return { status: "none", reason: "taken" };
      const groups = new Map();
      for (const c of free) {
        const k = printingKey(c);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }
      const printings = [...groups].map(([key, list]) => ({ key, card: list[0], free: list.length }));
      const pick = printings.length === 1 ? printings[0] : printings.find(p => p.key === row.pick);
      if (!pick) return { status: "choose", printings };
      taken.add(pick.card.id);
      return { status: "match", cardId: pick.card.id, printings, pick: pick.key };
    });
  }

  const cents = n => Math.round(Number(n) * 100);

  /* Split `tax` (dollars) across cards with these prices, in proportion; a card without a price
     takes none. The cents left over after rounding go to the cards rounded down the most. When no
     card costs anything, it's split evenly across the cards priced at 0 (or all of them, when none
     has a price). Returns each card's share in dollars. */
  function allocate(tax, prices) {
    const t = cents(tax), n = (prices || []).length;
    if (!n || !(t > 0)) return (prices || []).map(() => 0);
    const priced = p => typeof p === "number" && p >= 0;
    let w = prices.map(p => (priced(p) && p > 0 ? cents(p) : 0));
    if (!w.some(x => x > 0)) w = prices.some(priced) ? prices.map(p => (priced(p) ? 1 : 0)) : prices.map(() => 1);
    const sum = w.reduce((a, b) => a + b, 0);
    const raw = w.map(x => (t * x) / sum), out = raw.map(Math.floor);
    let left = t - out.reduce((a, b) => a + b, 0);
    raw.map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .filter(({ i }) => w[i] > 0)
      .sort((a, b) => b.frac - a.frac || a.i - b.i)
      .forEach(({ i }) => { if (left > 0) { out[i]++; left--; } });
    return out.map(c => c / 100);
  }

  /* What a card cost: its price and its share of the tax, to the cent. */
  const cost = (price, share) => (cents(price) + cents(share || 0)) / 100;

  root.BinderBulkBuy = { match, allocate, cost, numberMatches, nameScore, printingKey };
})(typeof window !== "undefined" ? window : globalThis);
