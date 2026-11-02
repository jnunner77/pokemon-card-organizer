/* Open trades: several trades with dealers worked out at once, each a tab in the trade evaluator
   (public/trade.js works one out). Editors' trades are kept on the server (api/open-trades, shared
   by every device that can edit); this file is the browser's side of that:
   - blank, isEmpty, label, summary, nextNumber: a trade and how its tab reads;
   - toWire: what a save sends; afterClose: which tab to show once one closes;
   - reconcile: this device's trades against the server's (which wins, what clashes, what closed);
   - fromLegacy: the single trade an earlier version kept in this browser, as an open trade;
   - createSaver: saves a trade ~1 s after each change, one request in flight per trade, and tries
     again with growing waits while the server can't be reached.
   A plain script, loaded after trade.js: the page uses window.BinderTrades, and the tests load it the same way. */
(function (root) {
  "use strict";

  const MAX = 10, MAX_CUSTOMER = 40, MAX_FIELD = 20, MAX_SIDE_CARDS = 100; // the server's limits (src/domain/open-trades/open-trade.ts)

  const side = () => ({ pct: "100", cash: "", items: [] });
  /* A new trade numbered n; its id is chosen when the page makes it. */
  const blank = n => ({ id: null, n, customer: "", dealer: side(), mine: side(), version: 0 });

  const typed = s => String(s ?? "").trim() !== "";
  /* Nothing in it yet: no customer, cards or cash, and the percentages as they start. */
  function isEmpty(t) {
    if (!t) return true;
    if (typed(t.customer)) return false;
    return ["dealer", "mine"].every(k => {
      const s = t[k] || {};
      return !(s.items || []).length && !typed(s.cash) && (!typed(s.pct) || String(s.pct).trim() === "100");
    });
  }
  const label = t => (typeof t?.customer === "string" && t.customer.trim()) || `Trade ${t?.n ?? ""}`.trim();

  /* "Empty", "1 card", "3 cards · $40.00 cash": cards on both sides, cash on both sides. */
  function summary(t) {
    const BT = root.BinderTrade;
    const cards = ["dealer", "mine"].reduce((a, k) => a + (t?.[k]?.items || []).length, 0);
    const cash = ["dealer", "mine"].reduce((a, k) => a + Math.round((BT.amount(t?.[k]?.cash) ?? 0) * 100), 0);
    const parts = [cards ? `${cards} card${cards === 1 ? "" : "s"}` : "", cash ? `$${(cash / 100).toFixed(2)} cash` : ""].filter(Boolean);
    return parts.join(" · ") || "Empty";
  }

  /* The lowest number from 1 that no trade has. */
  function nextNumber(trades) {
    const used = new Set((trades || []).map(t => t.n));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  /* A save: the version it starts from and the trade, without the page's own bookkeeping. */
  function toWire(t) {
    const sideOf = s => ({ pct: String(s?.pct ?? "100"), cash: String(s?.cash ?? ""), items: (s?.items || []).map(({ key, lookState, ...it }) => it) });
    return { baseVersion: t.version || 0, customer: String(t.customer ?? "").trim().slice(0, MAX_CUSTOMER), dealer: sideOf(t.dealer), mine: sideOf(t.mine) };
  }

  /* Which trade to show once `closedId` closes: its right neighbour, else its left, else null (a fresh trade). */
  function afterClose(trades, closedId) {
    const i = (trades || []).findIndex(t => t.id === closedId);
    if (i < 0) return trades?.[0]?.id ?? null;
    return trades[i + 1]?.id ?? trades[i - 1]?.id ?? null;
  }

  const fromServer = v => ({ id: v.id, n: v.number, customer: v.customer || "", dealer: v.dealer, mine: v.mine, version: v.version });

  /**
   * This device's trades against the server's list (views as GET api/open-trades gives them).
   * `pending` is the ids of the trades with changes not saved yet. Per trade:
   * - only on the server: taken;
   * - on both, nothing unsaved here: the server's, unless this has a newer version (the list was
   *   fetched before a save and answered after it): then this is kept;
   * - on both, unsaved here and the server's version is the one this started from: kept (it saves next);
   * - on both, unsaved here but the server has moved on: the server's is taken and this one is
   *   reported in `conflicts` as `mine`, to keep if wanted;
   * - only here and never saved: kept (a new trade); only here but it was saved before: it was
   *   recorded or discarded elsewhere, so it's dropped and reported in `closed`.
   * `since` (optional) is the versions the trades had when the list was asked for (id → version): a trade
   * that was never saved then isn't "closed elsewhere" for being missing from an older list.
   * Returns {trades, conflicts: [{id, mine}], closed: [trade]}, the trades in number order.
   */
  function reconcile(local, server, pending, since) {
    const isPending = id => typeof pending?.has === "function" ? pending.has(id) : (pending || []).includes(id);
    const byId = new Map((server || []).map(v => [v.id, v]));
    const out = [], conflicts = [], closed = [];
    for (const t of local || []) {
      const v = byId.get(t.id);
      if (!v) { if (t.version > 0 && (!since || (since.get(t.id) ?? 0) > 0)) closed.push(t); else out.push(t); continue; }
      byId.delete(t.id);
      if (isPending(t.id) && v.version <= t.version) out.push(t);
      else if (isPending(t.id)) { out.push(fromServer(v)); conflicts.push({ id: t.id, mine: t }); }
      else if (v.version < t.version) out.push(t);
      else out.push(fromServer(v));
    }
    for (const v of byId.values()) out.push(fromServer(v));
    // a new trade numbered like one from the server takes the next free number
    const taken = new Set(out.filter(t => t.version > 0).map(t => t.n));
    for (const t of out) if (t.version === 0 && taken.has(t.n)) { const used = new Set([...taken, ...out.map(x => x.n)]); let n = 1; while (used.has(n)) n++; t.n = n; }
    out.sort((a, b) => a.n - b.n);
    return { trades: out, conflicts, closed };
  }

  /* The trade an earlier version kept in this browser (localStorage bl:trade), as a new open trade
     numbered n; null when it has nothing in it. ownedIds and graders are as BinderTrade.restore takes them. */
  function fromLegacy(saved, n, ownedIds, graders) {
    if (!saved || typeof saved !== "object") return null;
    const r = root.BinderTrade.restore(saved, ownedIds || null, graders || []);
    const t = { ...blank(n), dealer: r.dealer, mine: r.mine };
    return isEmpty(t) ? null : t;
  }

  /**
   * Saves trades to the server. Options (all injectable for tests):
   * - put(id, wire) → the saved view; del(id); wait(ms) → a promise;
   * - delayMs: the wait after the last change before saving; retryMs: waits between tries while the
   *   server can't be reached (the last repeats).
   * Callbacks: onSaved(id, view), onConflict(id) (changed elsewhere meanwhile), onClosed(id)
   * (recorded or discarded elsewhere), onFull(id) (too many open trades), onInvalid(id) (the server refuses it as it is, e.g. too long: not retried
   until the trade changes), onDenied(id) (this account may not save it: view-only, or signed out; not retried until the trade
   changes or retryAll), onStatus(id).
   * A trade's status is 'saved', 'saving' or 'unsaved' (tried and couldn't, trying again), 'invalid' (refused; kept here) or
   'denied' (this account may not; kept here).
   * changed(t) takes the trade itself and reads its version when each save is sent, so onSaved
   * should update the trade's version before the next goes.
   */
  function createSaver(o) {
    const delayMs = o.delayMs ?? 1000, retryMs = o.retryMs || [5000, 15000, 30000];
    const wait = o.wait || (ms => new Promise(r => setTimeout(r, ms)));
    const call = (name, ...a) => { try { o[name]?.(...a); } catch (_) { /* a failing listener must not stop saving */ } };
    const entries = new Map();
    const entry = id => { let e = entries.get(id); if (!e) { e = { id, t: null, gen: 0, dirty: false, state: "saved", inflight: null, tries: 0, kick: null, gone: false, waiters: [] }; entries.set(id, e); } return e; };
    const setState = (e, s) => { if (e.state !== s) { e.state = s; call("onStatus", e.id); } };
    const netFail = err => !err || !["trade_changed", "trade_closed", "too_many_trades"].includes(err.code);
  /* 403 forbidden (view-only), 401 (runtime.js gives not_granted and goes to sign in; the server's code is signin). */
  const denied = err => ["forbidden", "signin", "not_granted"].includes(err?.code);

    const flush = e => { const w = e.waiters; e.waiters = []; w.forEach(r => r()); };
    function run(e) {
      if (e.inflight) return e.inflight;
      e.inflight = (async () => {
        while (e.dirty && !e.gone) {
          e.dirty = false;
          setState(e, "saving");
          let retry = false;
          try {
            const view = await o.put(e.id, toWire(e.t));
            e.tries = 0;
            if (e.gone) break;
            call("onSaved", e.id, view);
            if (!e.dirty) setState(e, "saved");
          } catch (err) {
            if (e.gone) break;
            if (err?.code === "trade_changed") { e.dirty = false; setState(e, "unsaved"); call("onConflict", e.id); }
            else if (err?.code === "trade_closed") { e.dirty = false; e.gone = true; entries.delete(e.id); call("onClosed", e.id); }
            else if (err?.code === "invalid_argument" || err?.code === "too_large") { e.dirty = false; setState(e, "invalid"); call("onInvalid", e.id); }
            else if (err?.code === "too_many_trades") { e.dirty = false; setState(e, "unsaved"); call("onFull", e.id); }
            else if (denied(err)) { e.dirty = false; setState(e, "denied"); call("onDenied", e.id); }
            else { e.dirty = true; retry = true; setState(e, "unsaved"); }
          }
          flush(e);
          if (retry) {
            const ms = retryMs[Math.min(e.tries++, retryMs.length - 1)];
            await Promise.race([wait(ms), new Promise(r => { e.kick = r; })]);
            e.kick = null;
          }
        }
      })().finally(() => { e.inflight = null; flush(e); });
      return e.inflight;
    }

    return {
      /* The trade changed: save it after a quiet moment (a change while a save is on its way goes after it). */
      changed(t) {
        const e = entry(t.id);
        if (e.gone) return;
        e.t = t; e.dirty = true;
        const gen = ++e.gen;
        if (e.state === "saved" || e.state === "invalid" || e.state === "denied") setState(e, "saving");
        if (e.inflight) return;
        wait(delayMs).then(() => { if (e.gen === gen && !e.gone && e.dirty) void run(e); });
      },
      /* Takes the trade off the server. Waits for a save on its way first, cancels the ones waiting, and
         tries again until the server answers. Resolves true when it's gone, false when it gave up, null when this
         account may not (view-only or signed out: the page keeps it waiting for an account that may). */
      async discard(id) {
        const e = entry(id);
        e.gen++; e.dirty = false;
        if (e.inflight) { e.gone = true; await e.inflight.catch(() => {}); }
        e.gone = true; entries.delete(id);
        for (let tries = 0; ; tries++) {
          try { await o.del(id); return true; }
          catch (err) {
            if (denied(err)) return null;
            if (!netFail(err) || err?.code === "invalid_argument") return false;
            await wait(retryMs[Math.min(tries, retryMs.length - 1)]);
          }
        }
      },
      /* Sends what's waiting now instead of after the quiet moment, and resolves once nothing is on its way
         (or the server didn't answer: the trade stays unsaved). */
      async settle(id) {
        const e = entries.get(id);
        while (e && !e.gone && (e.inflight || e.dirty)) {
          e.gen++;
          const done = new Promise(r => e.waiters.push(r));
          if (!e.inflight) void run(e); else if (e.kick) e.kick();
          await done;
          if (e.state === "unsaved") return;
        }
      },
      /* The trade is gone from this device: stop saving it. */
      forget(id) { const e = entries.get(id); if (!e) return; e.gone = true; e.dirty = false; e.gen++; if (e.kick) e.kick(); entries.delete(id); },
      /* Tries every unsaved trade now (the server is reachable again), and once more the ones this account was refused. */
      retryAll() {
        for (const e of entries.values()) {
          if (e.dirty && e.kick) e.kick();
          else if (e.state === "denied" && e.t && !e.inflight && !e.gone) { e.dirty = true; e.gen++; void run(e); }
        }
      },
      status: id => entries.get(id)?.state ?? "saved",
    };
  }

  root.BinderTrades = { MAX, MAX_CUSTOMER, MAX_FIELD, MAX_SIDE_CARDS, blank, isEmpty, label, summary, nextNumber, toWire, afterClose, reconcile, fromLegacy, createSaver };
})(typeof window !== "undefined" ? window : globalThis);
