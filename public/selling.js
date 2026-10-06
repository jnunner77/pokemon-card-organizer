/* The Selling view's numbers: the sales in a date range, their totals, what sold in each day, week
   or month, and the sales added up by occasion, where, set, binder, owner or month.
   A sale here is {card, sale}, sale being the page's saleInfo(): {soldCAD, cost, profit, date, where,
   bundle?}. A bundle's cards are each a row (each has its own share of the price and profit) and
   count once as a sale.
   A plain script: the page uses window.BinderSelling, and the tests load it the same way. */
(function (root) {
  "use strict";

  const DAY = 86400000;
  const isDate = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T12:00:00Z"));
  const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / DAY);
  const r2 = n => Math.round(n * 100) / 100;

  /* The sales dated from `from` to `to` (inclusive). withUndated: also the ones with no date (the All range). */
  function inRange(rows, from, to, withUndated) {
    return rows.filter(x => isDate(x.sale.date) ? x.sale.date >= from && x.sale.date <= to : !!withUndated);
  }

  /* The earliest sale date, or "" with none. */
  function earliest(rows) {
    return rows.reduce((m, x) => isDate(x.sale.date) && (!m || x.sale.date < m) ? x.sale.date : m, "");
  }

  /* How many sales: a bundle counts once, every other card on its own. */
  function salesCount(rows) {
    const bundles = new Set();
    let n = 0;
    for (const x of rows) {
      const b = x.sale.bundle && x.sale.bundle.id;
      if (!b) n++;
      else if (!bundles.has(b)) { bundles.add(b); n++; }
    }
    return n;
  }

  /* Profit as a % of what the cards cost, counting only the cards with a cost. */
  const margin = (profit, cost) => cost > 0 ? profit / cost * 100 : null;

  /* Totals: cards, sales, sold for, cost and profit (of the cards with a cost), margin on cost,
     average per card, the best sale, and how many have no cost (so no profit). */
  function totals(rows) {
    let soldFor = 0, cost = 0, profit = 0, noCost = 0, best = null;
    for (const x of rows) {
      const s = x.sale;
      soldFor += s.soldCAD || 0;
      if (s.profit != null && s.cost != null) { cost += s.cost; profit += s.profit; } else noCost++;
      if (!best || (s.soldCAD || 0) > (best.sale.soldCAD || 0)) best = x;
    }
    return {
      cards: rows.length, sales: salesCount(rows), soldFor: r2(soldFor), cost: r2(cost), profit: r2(profit),
      margin: margin(profit, cost), avg: rows.length ? r2(soldFor / rows.length) : null, best, noCost
    };
  }

  /* Bars for a range: a day each for up to a month, a week (from Monday) for up to half a year, then months. */
  function period(from, to) {
    const n = daysBetween(from, to);
    return n <= 31 ? "day" : n <= 183 ? "week" : "month";
  }
  /* The first day of the day, week or month a date falls in. */
  function bucketOf(date, per) {
    if (per === "month") return date.slice(0, 7) + "-01";
    if (per === "week") { const wd = new Date(date + "T12:00:00Z").getUTCDay(); return addDays(date, -((wd + 6) % 7)); }
    return date;
  }
  function nextBucket(start, per) {
    if (per === "month") { const y = +start.slice(0, 4), m = +start.slice(5, 7); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`; }
    return addDays(start, per === "week" ? 7 : 1);
  }

  /* What sold in each day, week or month from `from` to `to`, empty ones included:
     [{start, end, soldFor, profit, cards, sales}] (end: the bucket's last day, within the range). */
  function series(rows, from, to, per) {
    per = per || period(from, to);
    const out = [], at = new Map();
    for (let b = bucketOf(from, per); b <= to; b = nextBucket(b, per)) {
      const end = addDays(nextBucket(b, per), -1);
      const x = { start: b < from ? from : b, end: end > to ? to : end, soldFor: 0, profit: 0, cards: 0, list: [] };
      at.set(b, x); out.push(x);
    }
    for (const r of inRange(rows, from, to)) {
      const x = at.get(bucketOf(r.sale.date, per));
      if (!x) continue;
      x.soldFor += r.sale.soldCAD || 0; x.profit += r.sale.profit || 0; x.cards++; x.list.push(r);
    }
    return out.map(({ list, ...x }) => ({ ...x, soldFor: r2(x.soldFor), profit: r2(x.profit), sales: salesCount(list) }));
  }

  /* Sales added up by a key: [{key, cards, sales, soldFor, cost, profit, margin, noCost, last}],
     where last is the latest sale date in the group. */
  function groups(rows, keyOf) {
    const m = new Map();
    for (const x of rows) {
      const k = keyOf(x);
      if (!m.has(k)) m.set(k, { key: k, rows: [] });
      m.get(k).rows.push(x);
    }
    return [...m.values()].map(g => {
      const t = totals(g.rows);
      const last = g.rows.reduce((a, x) => isDate(x.sale.date) && x.sale.date > a ? x.sale.date : a, "");
      return { key: g.key, cards: t.cards, sales: t.sales, soldFor: t.soldFor, cost: t.cost, profit: t.profit, margin: t.margin, noCost: t.noCost, last };
    });
  }

  /* Keys for the groups. An occasion is where and when: the card show on the 14th, eBay on the 20th. */
  const NOWHERE = "Not recorded";
  const whereOf = s => (s.where || "").trim() || NOWHERE;
  const KEYS = {
    occasion: x => `${isDate(x.sale.date) ? x.sale.date : ""}|${whereOf(x.sale)}`,
    where: x => whereOf(x.sale),
    month: x => isDate(x.sale.date) ? x.sale.date.slice(0, 7) : ""
  };

  /* Sorting cards ({card, sale}) and groups alike: latest first, highest sale, most profit, biggest
     loss, best margin, most cards. Ties go to the latest. */
  const val = {
    soldFor: x => x.sale ? x.sale.soldCAD || 0 : x.soldFor,
    profit: x => x.sale ? x.sale.profit : x.profit,
    margin: x => x.sale ? (x.sale.profit != null ? margin(x.sale.profit, x.sale.cost) : null) : x.margin,
    date: x => (x.sale ? x.sale.date : x.last) || "",
    at: x => (x.sale ? x.sale.at : "") || "",
    cards: x => x.sale ? 1 : x.cards
  };
  const latest = (a, b) => val.date(b).localeCompare(val.date(a)) || val.at(b).localeCompare(val.at(a));
  const nullsLast = (f, dir) => (a, b) => {
    const x = f(a), y = f(b);
    if (x == null || y == null) return (x == null) - (y == null) || latest(a, b);
    return dir * (y - x) || latest(a, b);
  };
  const SORTS = {
    latest,
    sold: (a, b) => val.soldFor(b) - val.soldFor(a) || latest(a, b),
    profit: nullsLast(val.profit, 1),
    loss: nullsLast(val.profit, -1),
    margin: nullsLast(val.margin, 1),
    cards: (a, b) => val.cards(b) - val.cards(a) || val.soldFor(b) - val.soldFor(a) || latest(a, b)
  };
  function sortRows(rows, k) { return rows.slice().sort(SORTS[k] || SORTS.latest); }

  /* Filters of the Selling view, on top of the List view's (filter.js): where it sold. */
  function matchWhere(sale, where) { return !where || whereOf(sale) === where; }

  root.BinderSelling = { NOWHERE, isDate, inRange, earliest, salesCount, margin, totals, period, bucketOf, series, groups, KEYS, whereOf, sortRows, matchWhere };
})(typeof window !== "undefined" ? window : globalThis);
