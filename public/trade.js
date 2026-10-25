/* Trade evaluator: what a trade with a dealer comes to. Each side (the dealer's and mine) has cards
   and cash; the cards' values are market values in CAD, and each side has a trade percentage (the
   dealer takes my cards "at 80%") that a card can override with its own.
   - A card's trade value is its value times its percentage, to the cent; cash is never discounted.
   - In trade terms, the side giving less owes the difference in cash: that's the cash that evens it.
   - In market terms, what I get (the dealer's cards and cash) against what I give (my cards and
     cash) is what I gain or give up, and the rate my cards effectively go at.
   - Recorded (settle), what I gave is the dealer's cards' cost and what I got my cards' sale price,
     each split across that side's cards by value.
   Amounts are worked out in cents so totals add up exactly.
   A plain script, loaded after bulkbuy.js: the page uses window.BinderTrade, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* "12.50", "$1,200", " 7 " → 12.5, 1200, 7; "", "abc", "-3" → null */
  function amount(s) {
    if (typeof s === "number") return Number.isFinite(s) && s >= 0 ? s : null;
    const t = String(s ?? "").replace(/[$,\s]/g, "").replace(/^CA?/i, "");
    if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  /* "80", "80%", " 72.5 % " → 80, 80, 72.5; "", "abc", "-5" → null. Up to 1000%. */
  function percent(s) {
    if (typeof s === "number") return Number.isFinite(s) && s >= 0 && s <= 1000 ? s : null;
    const t = String(s ?? "").replace(/[%\s]/g, "");
    if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) && n <= 1000 ? n : null;
  }
  const typed = s => typeof s === "string" ? s.trim() !== "" : s != null;
  const cents = n => Math.round(n * 100);
  const dollars = c => c / 100;
  /* A card's trade value in cents: its value in cents times its percentage, rounded to the cent. */
  const tradeCents = (value, pct) => Math.round(cents(value) * pct / 100);
  /* A card's trade value in dollars, as the breakdown counts it ($0.29 at 50% is $0.15). */
  const cardTrade = (value, pct) => dollars(tradeCents(value, pct));

  /* One side: {pct, cash, items:[{value, pct}]} with values and percentages as typed (or numbers).
     The side's percentage is 100 when blank; a card's is the side's when blank. */
  function side(s) {
    const o = s || {};
    const pct = percent(o.pct) ?? 100;
    let market = 0, trade = 0, counted = 0, unvalued = 0, badPct = 0, mixed = false;
    for (const it of o.items || []) {
      const v = amount(it?.value);
      if (v == null) { unvalued++; continue; }
      const own = percent(it.pct);
      if (own == null && typed(it.pct)) badPct++;
      if (own != null && own !== pct) mixed = true;
      const p = own ?? pct;
      market += cents(v);
      trade += tradeCents(v, p);
      counted++;
    }
    const cash = cents(amount(o.cash) ?? 0);
    return {
      pct, mixed, counted, unvalued, items: (o.items || []).length,
      // typed but unreadable ("40 dollars", "80 pct"): counted as no cash, 100%, or the side's percentage
      unread: { cash: amount(o.cash) == null && typed(o.cash), pct: percent(o.pct) == null && typed(o.pct), cardPct: badPct },
      market: dollars(market), trade: dollars(trade), cash: dollars(cash), total: dollars(trade + cash),
      // what its cards come to overall, as a percentage of their market value (null with none)
      rate: market > 0 ? trade / market * 100 : null,
      _c: { market, trade, cash },
    };
  }

  /**
   * The whole trade: {dealer, mine} sides as above. Returns
   * - dealer, mine: each side's market value, trade value, cash and total (trade value + cash);
   * - even: the cash that balances it in trade terms, and who adds it ("dealer", "me", or null when
   *   it's already even);
   * - get, give, net, netPct: in market value, what I receive (dealer's cards + their cash), what I
   *   give (my cards + my cash), the difference, and that as a percentage of what I give;
   * - verdict: "ahead", "behind" or "even" (within a dollar or half a percent of what I give);
   * - myRate: what my cards effectively go for, as a percentage of their market value, counting
   *   the dealer's cards at market (null when I give no cards);
   * - theirRate: what the dealer's cards cost me as a percentage of their market value, counting
   *   my cards at market (null when the dealer gives no cards).
   */
  function evaluate(t) {
    const d = side(t?.dealer), m = side(t?.mine);
    const balance = (m._c.trade + m._c.cash) - (d._c.trade + d._c.cash);
    const get = d._c.market + d._c.cash, give = m._c.market + m._c.cash, net = get - give;
    const within = Math.abs(net) < 100 || (give > 0 && Math.abs(net) / give < 0.005);
    const strip = s => { const { _c, ...rest } = s; return rest; };
    return {
      dealer: strip(d), mine: strip(m),
      even: { cash: dollars(Math.abs(balance)), who: balance > 0 ? "dealer" : balance < 0 ? "me" : null },
      get: dollars(get), give: dollars(give), net: dollars(net),
      netPct: give > 0 ? net / give * 100 : null,
      verdict: get === 0 && give === 0 ? "empty" : within ? "even" : net > 0 ? "ahead" : "behind",
      myRate: m._c.market > 0 ? (d._c.market + d._c.cash - m._c.cash) / m._c.market * 100 : null,
      theirRate: d._c.market > 0 ? (m._c.market + m._c.cash - d._c.cash) / d._c.market * 100 : null,
    };
  }

  /* A grade as it's shown: "PSA 10", "BGS 9.5"; "" for a raw card or a grader with no grade. */
  function gradeLabel(grader, grade) {
    const g = String(grade ?? "").trim(), by = String(grader ?? "").trim();
    return by && by !== "Raw" && g ? `${by} ${g}` : "";
  }

  /* A percentage as it's shown: 80, 72.5, 87.3 (one decimal at most). */
  const pctText = n => n == null ? "" : String(Math.round(n * 10) / 10);

  /* The "Trade %" cell for a side (from side()): null with no cards counted (or no overall rate when
     its cards' percentages differ and they're all worth $0); the side's percentage; or, when cards
     have their own, the overall rate, marked overall. */
  function pctCell(s) {
    if (!s || !s.counted) return null;
    if (s.mixed) return s.rate == null ? null : { text: `${pctText(s.rate)}%`, overall: true };
    return { text: `${pctText(s.pct)}%`, overall: false };
  }

  /* The warnings under the breakdown (from evaluate()): cards with no value, and cash or
     percentages typed but unreadable, which count as $0, 100% or the side's percentage. */
  function warnings(r) {
    const out = [], nov = r.dealer.unvalued + r.mine.unvalued;
    if (nov) out.push(`${nov} card${nov === 1 ? " has" : "s have"} no value yet and ${nov === 1 ? "isn't" : "aren't"} counted.`);
    const unread = [[r.dealer, "the dealer's"], [r.mine, "your"]].flatMap(([s, who]) => {
      const n = s.unread.cardPct;
      return [
        s.unread.cash && `${who} cash isn't a number, so it counts as $0.00`,
        s.unread.pct && `${who} trade % isn't a number, so it counts as 100%`,
        n && `${n} of ${who} cards' own % ${n === 1 ? "isn't a number" : "aren't numbers"}, so ${n === 1 ? "it uses" : "they use"} the side's`,
      ];
    }).filter(Boolean);
    if (unread.length) out.push(unread.map(u => u[0].toUpperCase() + u.slice(1)).join(". ") + ".");
    return out;
  }

  /* PriceCharting's graded prices are labelled "Grade 9", "Grade 9.5", "PSA 10", "CGC 10 Pristine",
     "BGS 10 Black Label"…: the grade each is for, its grader (10s only) and whether it's special. */
  function gradeOfLabel(label) {
    const l = String(label ?? "").trim();
    let m = l.match(/^Grade (\d{1,2}(?:\.5)?)$/i);
    if (m) return { grade: Number(m[1]), grader: "", special: "" };
    m = l.match(/^([A-Z]+) 10( Pristine| Black Label)?$/i);
    if (m) return { grade: 10, grader: m[1].toUpperCase(), special: m[2] ? (/pristine/i.test(m[2]) ? "pristine" : "black") : "" };
    return null;
  }

  /**
   * The price for a graded card among a printing's graded prices ([{label, cad}]), as the daily update
   * picks it: its grader's and grade's (7 and 7.5 are "Grade 7", a 10 is its grader's own), else the
   * nearest grade there is (a 10 by its grader, then PSA's, then another's; the lower of two equally
   * near), never a Pristine or Black Label 10 for a plain one. {label, cad, exact}, or null for a raw
   * card, a grade it can't read, or no graded prices.
   */
  function gradePrice(grades, grader, grade) {
    const by = String(grader ?? "").trim().toUpperCase().replace(/^BECKETT$/, "BGS");
    const text = String(grade ?? "").toLowerCase();
    const num = Number(text.match(/\d{1,2}(?:\.\d)?/)?.[0]);
    if (!by || by === "RAW" || !(num >= 1 && num <= 10)) return null;
    const special = /pristine/.test(text) ? "pristine" : /black/.test(text) ? "black" : "";
    const priced = (grades || []).map(g => ({ g, k: gradeOfLabel(g?.label) })).filter(x => x.k && typeof x.g.cad === "number");
    const own = k => num >= 10
      ? k.grade === 10 && k.grader === by && k.special === (special && k.grader === by ? special : "")
      : k.grade === (num >= 7 && num < 9 ? Math.floor(num) : num) && !k.grader;
    const exact = priced.find(x => own(x.k));
    if (exact) return { label: exact.g.label, cad: exact.g.cad, exact: true };
    const near = priced
      .filter(x => !x.k.special || (x.k.special === special && x.k.grader === by))
      .map(x => ({ x, d: Math.abs(x.k.grade - num), rank: x.k.grader === by ? 0 : x.k.grader === "PSA" ? 1 : x.k.grader ? 2 : 0 }))
      .sort((a, b) => a.d - b.d || a.rank - b.rank || a.x.k.grade - b.x.k.grade);
    const hit = near[0]?.x;
    return hit ? { label: hit.g.label, cad: hit.g.cad, exact: false } : null;
  }

  /**
   * A card looked up in the card database, as the trade keeps it: from the search hit ({id, name,
   * set, number, total, thumb}) and the card's prices ({printings:[{label, variant, price:{cad},
   * pricecharting:{grades:[{label, cad}]}}]}). Each printing keeps its variant (for the card a
   * recorded trade adds), price and graded prices in CAD; the one shown first is the first with a
   * price (the regular card comes first).
   */
  function lookFrom(hit, card) {
    const h = hit || {}, num = h.total && /^\d+$/.test(String(h.number)) ? `${h.number}/${h.total}` : String(h.number ?? "");
    const printings = (Array.isArray(card?.printings) ? card.printings : []).map(p => ({
      label: String(p?.label ?? ""), variant: String(p?.variant ?? ""),
      cad: typeof p?.price?.cad === "number" ? p.price.cad : null,
      grades: (Array.isArray(p?.pricecharting?.grades) ? p.pricecharting.grades : []).filter(g => g && typeof g.cad === "number").map(g => ({ label: String(g.label ?? ""), cad: g.cad })),
    }));
    const first = printings.findIndex(p => p.cad != null);
    return { id: String(h.id ?? ""), name: String(h.name ?? ""), set: String(h.set ?? ""), number: num, thumb: String(h.thumb ?? ""), printings, pi: first < 0 ? 0 : first };
  }

  /**
   * What a looked-up card is worth as its printing, grader and grade: {value, from} with where the
   * value comes from ("today's price, regular", "PriceCharting's PSA 10 price", or the nearest grade
   * it has), or {value: null, why} when there's no price for it.
   */
  function lookValue(look, grader, grade) {
    const p = look?.printings?.[look.pi] || look?.printings?.[0];
    if (!p) return { value: null, why: "No prices for this card" };
    const g = gradeLabel(grader, grade);
    if (g) {
      const gp = gradePrice(p.grades, grader, grade);
      if (!gp) return { value: null, why: `No ${g} price from PriceCharting` };
      return { value: gp.cad, from: gp.exact ? `PriceCharting's ${gp.label} price` : `PriceCharting's ${gp.label} price (it has none for ${g})` };
    }
    return p.cad == null ? { value: null, why: `No price for the ${p.label || "card"}` } : { value: p.cad, from: `today's price, ${p.label || "regular"}` };
  }

  /* A looked-up card's value after its printing or grade changes (lookValue's answer): a price for
     them replaces the value; with none, a value the lookup had filled in is cleared rather than kept
     for another grade, and a value typed by hand (valueFrom "") stays. {value, valueFrom}. */
  function followLook(it, lv) {
    if (lv && lv.value != null) return { value: lv.value.toFixed(2), valueFrom: lv.from };
    return it.valueFrom ? { value: "", valueFrom: "" } : { value: it.value, valueFrom: "" };
  }

  /* Cash with an amount added (the cash that evens the trade): "40" + 12.5 → "52.50"; unreadable or blank cash counts as $0. */
  const addCash = (cash, add) => dollars(cents(amount(cash) ?? 0) + cents(add)).toFixed(2);

  /* A typed-in card with a grader but no grade yet. */
  function missingGradeNote(it) {
    const by = String(it?.grader ?? "").trim();
    return by && by !== "Raw" && !String(it?.grade ?? "").trim() ? `Put in its ${by} grade.` : null;
  }

  /* A looked-up card as it was saved (lookFrom's shape), or null. Its printings are null when its
     prices hadn't come back yet, so they're asked for again. */
  function savedLook(l) {
    if (!l || typeof l !== "object" || typeof l.id !== "string" || !l.id) return null;
    const str = v => typeof v === "string" ? v : "";
    const printings = Array.isArray(l.printings) ? l.printings.filter(p => p && typeof p === "object").map(p => ({
      label: str(p.label), variant: str(p.variant), cad: typeof p.cad === "number" ? p.cad : null,
      grades: (Array.isArray(p.grades) ? p.grades : []).filter(g => g && typeof g.cad === "number").map(g => ({ label: str(g.label), cad: g.cad })),
    })) : null;
    const pi = Number.isInteger(l.pi) && printings && l.pi >= 0 && l.pi < printings.length ? l.pi : 0;
    return { id: l.id, name: str(l.name), set: str(l.set), number: str(l.number), thumb: str(l.thumb), printings, pi };
  }

  /**
   * A trade saved in the browser, read back: {dealer, mine}, each {pct, cash, items:[{cardId, look,
   * name, grader, grade, value, valueFrom, pct}]} with the other fields strings. Anything that isn't a
   * saved trade gives an empty one; a grader not in `graders` is "Raw"; only my side's cards link to a
   * card of mine (cardId, else null), and only the dealer's to a looked-up card (look, else null). `ownedIds` is the set of card ids I own, or null
   * when the ledger isn't loaded: with a set, my linked cards not in it (gone, sold, traded) are
   * dropped; with null, they're all kept.
   */
  function restore(saved, ownedIds, graders) {
    const str = v => typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
    const id = v => typeof v === "string" && v ? v : null;
    const out = {};
    for (const k of ["dealer", "mine"]) {
      const s = saved && typeof saved === "object" ? saved[k] : null;
      const ok = s && typeof s === "object";
      const items = (ok && Array.isArray(s.items) ? s.items : []).filter(it => it && typeof it === "object").map(it => ({
        cardId: k === "mine" ? id(it.cardId) : null, look: k === "dealer" ? savedLook(it.look) : null,
        name: str(it.name), grader: (graders || []).includes(it.grader) ? it.grader : "Raw",
        grade: str(it.grade), value: str(it.value), valueFrom: str(it.valueFrom), pct: str(it.pct),
      }));
      out[k] = {
        pct: ok ? str(s.pct) : "100", cash: ok ? str(s.cash) : "",
        items: k === "mine" && ownedIds ? items.filter(it => !it.cardId || ownedIds.has(it.cardId)) : items,
      };
    }
    return out;
  }


  /**
   * What recording the trade puts on each card, in market terms, from the same sides evaluate()
   * takes ({dealer, mine}, each with cash and items' values as typed):
   * - forTheirs: what I gave for the dealer's cards (my cards' values and my cash, less the dealer's
   *   cash; never below $0), and paid: each dealer card's share of it, by value;
   * - forMine: what I got for my cards (the dealer's cards' values and their cash, less my cash;
   *   never below $0), and sold: each of my cards' share of it, by value;
   * - gaveCash, gotCash: the cash each way; missing: how many cards have no value yet (the trade
   *   can't be recorded until every card has one).
   * The shares add up to their totals exactly, to the cent (bulkbuy.js allocate).
   */
  function settle(t) {
    const values = k => (t?.[k]?.items || []).map(it => amount(it?.value));
    const d = values("dealer"), m = values("mine");
    const sum = list => list.reduce((a, v) => a + cents(v ?? 0), 0);
    const dc = cents(amount(t?.dealer?.cash) ?? 0), mc = cents(amount(t?.mine?.cash) ?? 0);
    const forTheirs = Math.max(0, sum(m) + mc - dc), forMine = Math.max(0, sum(d) + dc - mc);
    const split = (total, list) => root.BinderBulkBuy.allocate(dollars(total), list);
    return {
      missing: [...d, ...m].filter(v => v == null).length,
      forTheirs: dollars(forTheirs), forMine: dollars(forMine), paid: split(forTheirs, d), sold: split(forMine, m),
      gaveCash: dollars(mc), gotCash: dollars(dc),
    };
  }

  /* The card a dealer's card becomes in my ledger when the trade is recorded: a looked-up card's
     name, set, number and printing, or what was typed in, with its grader and grade. */
  function newCard(it) {
    const L = it?.look, p = L?.printings?.[L.pi];
    const graded = it?.grader && it.grader !== "Raw";
    return {
      name: String((L ? L.name : it?.name) ?? "").trim(), set: L ? L.set : "", number: L ? L.number : "", variant: p?.variant || "",
      grader: graded ? it.grader : "Raw", grade: graded ? String(it.grade ?? "").trim() : "",
    };
  }

  /* What stops the trade being recorded, as the record step says it, or "" when nothing does.
     lands: each dealer card's landing ("ph:<placeholder id>", "b:<binder id>", or "" for no binder);
     given: how many of my cards are in the ledger (and so change). */
  function recordProblem(t, lands, given) {
    const s = settle(t), got = t?.dealer?.items || [];
    if (s.missing) return `${s.missing} card${s.missing === 1 ? " has" : "s have"} no value yet. Go back and put ${s.missing === 1 ? "it" : "them"} in.`;
    if (!got.length && !given) return "There's nothing in your ledger to change: add the dealer's cards, or cards of yours.";
    if (got.some(it => !newCard(it).name)) return "Give every card you get a name. Go back and type it in.";
    const phs = (lands || []).filter(v => String(v).startsWith("ph:"));
    if (new Set(phs).size !== phs.length) return "Two cards fill the same placeholder: choose somewhere else for one of them.";
    return "";
  }

  const usd = n => `$${n.toFixed(2)}`;
  const round2 = n => Math.round(n * 100) / 100;

  /**
   * The trade as POST api/trades takes it (src/presentation/ledger/parse.ts tradeRecord). o:
   * - id, date, at, who (traded with, may be blank), newId(): a new id each call;
   * - mine: per I-give card, {cardId, cost, basis} (its cost basis) when it's a card of mine in the
   *   ledger that changes, else null (typed in: it counts in the split but nothing is recorded for it);
   * - lands: per dealer card, its landing (as recordProblem); owner(binderId): a new card's owner.
   * My ledger cards get a sale of their share of what I got, with its profit; each dealer card a
   * Paid entry of its share of what I gave and a market entry of its value, as a new card or
   * filling its placeholder. The summary (cash each way, how many cards, who with) goes on every card.
   */
  function recordBody(t, o) {
    const s = settle(t), gave = (t?.mine?.items || []).length, got = (t?.dealer?.items || []).length;
    const n = (k, cash) => [k ? `${k} card${k === 1 ? "" : "s"}` : "", cash ? usd(cash) : ""].filter(Boolean).join(" + ") || "nothing";
    const note = `Trade${o.who ? ` with ${o.who}` : ""}: ${n(gave, s.gaveCash)} for ${n(got, s.gotCash)}`;
    const entry = (type, amt, extra) => ({ id: o.newId(), at: o.at, type, amount: amt, currency: "CAD", date: o.date, where: "Trade", note, ...extra });
    const given = [];
    (o.mine || []).forEach((m, i) => {
      if (!m) return;
      const sold = s.sold[i], cost = m.cost == null ? null : round2(m.cost);
      given.push({ id: m.cardId, entry: entry("mysale", sold), sale: { amount: sold, currency: "CAD", soldCAD: sold, cost, basis: m.basis, profit: cost == null ? null : round2(sold - cost), date: o.date, where: "Trade", at: o.at } });
    });
    const received = (t?.dealer?.items || []).map((it, i) => {
      const value = amount(it.value), card = newCard(it), land = String(o.lands?.[i] ?? "");
      const entries = [entry("paid", s.paid[i]), ...(value == null ? [] : [entry("market", value, { note: it.valueFrom ? `Value in the trade: ${it.valueFrom}` : "Value in the trade" })])];
      if (land.startsWith("ph:")) return { id: land.slice(3), placeholder: true, grader: card.grader, grade: card.grade, entries };
      const binderId = land.startsWith("b:") ? land.slice(2) : null;
      return { id: o.newId(), binderId, entries, doc: { ...card, setCode: "", rarity: "", artist: "", language: "English", condition: "Near Mint", notes: "", owner: o.owner(binderId), imageId: null } };
    });
    const summary = { date: o.date, gaveCash: s.gaveCash, gotCash: s.gotCash, gave, got, ...(o.who ? { with: o.who } : {}) };
    return { id: o.id, summary, given, received };
  }

  /**
   * Where each card I get goes when the record step opens: what was chosen before, while it's still
   * on offer (its binder still there, its placeholder still free for it), else its placeholder (the
   * one it fills alongside the others), else no binder (""). items: [{key, ph: placeholder id or
   * null, phIds: the placeholders on offer for it}]; before: {key: landing} chosen earlier;
   * binderIds: the binders and cases there are now. Returns {key: landing}.
   */
  function landings(items, before, binderIds) {
    const binders = new Set(binderIds || []), out = {};
    for (const x of items || []) {
      const v = before?.[x.key], fallback = x.ph ? `ph:${x.ph}` : "";
      const ok = typeof v === "string" && (v === "" || (v.startsWith("b:") && binders.has(v.slice(2))) || (v.startsWith("ph:") && (x.phIds || []).includes(v.slice(3))));
      out[x.key] = ok ? v : fallback;
    }
    return out;
  }

  /**
   * The Sales tab's rows, newest first: a bundle's sales together, a trade's sales together, and a
   * trade where I gave no card of mine (cash only) as a group of its own, found by the cards I got.
   * sales: [{c, s}] newest first (s: the sale, with its date, bundle and trade); cards: every card.
   * Returns sales ({c, s}), {bundle, items} and {trade, items} groups (items [] for a cash-only trade).
   */
  function salesGroups(sales, cards) {
    const groups = [], byKey = new Map();
    for (const x of sales || []) {
      const b = x.s.bundle?.id, tr = x.s.trade?.id, key = b ? `b:${b}` : tr ? `t:${tr}` : null;
      if (!key) { groups.push(x); continue; }
      if (!byKey.has(key)) { const g = b ? { bundle: x.s.bundle, items: [] } : { trade: x.s.trade, items: [] }; byKey.set(key, g); groups.push(g); }
      byKey.get(key).items.push(x);
    }
    for (const c of cards || []) {
      const T = c.trade;
      if (T?.id && !byKey.has(`t:${T.id}`)) { const g = { trade: T, items: [] }; byKey.set(`t:${T.id}`, g); groups.push(g); }
    }
    const dateOf = g => String((g.items ? g.items[0]?.s.date ?? g.trade?.date : g.s.date) || "");
    return groups.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  }

  root.BinderTrade = { settle, newCard, recordProblem, recordBody, landings, salesGroups, amount, percent, evaluate, cardTrade, gradeLabel, pctText, pctCell, warnings, missingGradeNote, gradePrice, lookFrom, lookValue, followLook, addCash, restore };
})(typeof window !== "undefined" ? window : globalThis);
