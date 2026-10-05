/* The Pricing view's numbers: what a set of cards was worth on each day of a date range, and how
   much each card (or set, binder, owner) moved. Each date values the cards at that date's prices:
   a card's latest price logged on or before it. A card first priced later in the range counts at
   its first price before then, so the line shows prices moving, not cards being added.
   A plain script: the page uses window.BinderPortfolio, and the tests load it the same way. */
(function (root) {
  "use strict";

  const DAY = 86400000;
  const RANGES = [["7d", "7D", 7], ["30d", "30D", 30], ["90d", "90D", 90], ["1y", "1Y", 365], ["all", "All"], ["custom", "Custom"]];
  const isDate = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T12:00:00Z"));
  const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / DAY);

  /* A card's value history, oldest first: [{date, value}], one per date (the last logged that day).
     value(card, price) turns a logged price into the card's value in CAD, or null to skip it. */
  function history(card, value) {
    const list = (Array.isArray(card.prices) ? card.prices : [])
      .filter(p => p && (p.type === "market" || p.type === "comp") && typeof p.amount === "number" && isDate(p.date))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.at || "").localeCompare(b.at || ""));
    const out = [];
    for (const p of list) {
      const v = value(card, p);
      if (v == null || isNaN(v)) continue;
      if (out.length && out[out.length - 1].date === p.date) out[out.length - 1].value = v;
      else out.push({ date: p.date, value: v });
    }
    return out;
  }

  /* The value on a date: the latest entry on or before it, else the first entry; null with no history. */
  function valueAt(hist, date) {
    if (!hist.length) return null;
    let lo = 0, hi = hist.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (hist[m].date <= date) { at = m; lo = m + 1; } else hi = m - 1; }
    return hist[at < 0 ? 0 : at].value;
  }

  /* The from and to dates of a range. today: YYYY-MM-DD; earliest: the first price date, for All. */
  function range(key, today, custom, earliest) {
    const r = RANGES.find(x => x[0] === key);
    if (r && r[2]) return { from: addDays(today, -r[2]), to: today };
    if (key === "custom" && custom) {
      let to = isDate(custom.to) && custom.to < today ? custom.to : today;
      let from = isDate(custom.from) ? custom.from : addDays(to, -30);
      if (from > to) [from, to] = [to, from];
      return { from, to };
    }
    if (key === "all") return { from: isDate(earliest) && earliest < today ? earliest : addDays(today, -30), to: today };
    return { from: addDays(today, -30), to: today };
  }

  /* The dates to plot: every day for up to ~4 months, then evenly spaced, always ending on `to`. */
  function dates(from, to, maxPoints) {
    const n = Math.max(0, daysBetween(from, to)), step = Math.max(1, Math.ceil(n / (maxPoints || 120)));
    const out = [];
    for (let k = n; k > 0; k -= step) out.push(addDays(from, k));
    out.push(from);
    return out.reverse();
  }

  /* The total value of the cards on each plotted date. hists: each card's history(). */
  function series(hists, from, to, maxPoints) {
    const ds = dates(from, to, maxPoints);
    const withHist = hists.filter(h => h.length);
    return ds.map(date => ({ date, value: Math.round(withHist.reduce((t, h) => t + valueAt(h, date), 0) * 100) / 100 }));
  }

  const pct = (start, end) => start > 0 ? (end - start) / start * 100 : null;

  /* Each card's start and end value and change. items: [{card, hist}]; cards with no history are left out. */
  function movers(items, from, to) {
    return items.filter(x => x.hist.length).map(x => {
      const start = valueAt(x.hist, from), end = valueAt(x.hist, to);
      return { card: x.card, start, end, change: end - start, pct: pct(start, end) };
    });
  }

  /* Movers added up by a key (set, binder, owner): [{key, n, start, end, change, pct}], biggest first. */
  function groups(rows, keyOf) {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r.card);
      const g = m.get(k) || { key: k, n: 0, start: 0, end: 0 };
      g.n++; g.start += r.start; g.end += r.end;
      m.set(k, g);
    }
    return [...m.values()].map(g => ({ ...g, change: g.end - g.start, pct: pct(g.start, g.end) })).sort((a, b) => b.end - a.end);
  }

  const SORTS = {
    change: (a, b) => Math.abs(b.change) - Math.abs(a.change),
    gain: (a, b) => b.change - a.change,
    drop: (a, b) => a.change - b.change,
    pct: (a, b) => Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0),
    value: (a, b) => b.end - a.end
  };
  function sortRows(rows, k) { return rows.slice().sort((SORTS[k] || SORTS.change)); }

  root.BinderPortfolio = { RANGES, isDate, addDays, daysBetween, history, valueAt, range, dates, series, movers, groups, sortRows };
})(typeof window !== "undefined" ? window : globalThis);
