/* Saving many cards one request each (the Price dialog): a few at a time, slowing down instead of
   failing when the server says to wait, and stopping when saving isn't possible at all.
   A plain script: the page uses window.BinderBulk, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* these mean no card will save: stop instead of trying them all */
  const FATAL = new Set(["forbidden", "not_granted", "revoked", "quota_exceeded"]);
  const RETRY = new Set(["unavailable", "resource_exhausted"]);

  /* Saves every id with save(id) (a promise), `concurrency` at a time.
     Returns {saved: ids, failed: [{id, error}], stopped: error | null}; never rejects. */
  async function run(ids, save, opts = {}) {
    const concurrency = opts.concurrency || 4, tries = opts.tries || 5;
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms))), now = opts.now || Date.now;
    const outcome = new Map();
    let next = 0, startAt = 0, gapMs = 0, stopped = null, settled = 0;

    const done = (id, error) => {
      outcome.set(id, error || null); settled++;
      if (opts.onProgress) { try { opts.onProgress(settled, ids.length, [...outcome.values()].filter(x => !x).length); } catch (_) {} }
    };
    async function one(id) {
      /* a rate-limited answer means wait and go on: it doesn't count against the tries */
      for (let attempt = 0; ; ) {
        const wait = Math.max(0, startAt - now());
        if (wait) await sleep(wait);
        startAt = Math.max(now(), startAt) + gapMs;
        try { await save(id); return done(id); }
        catch (e) {
          if (e && e.code === "rate_limited") {
            const ms = (e.retryAfter || 1) * 1000;
            startAt = Math.max(startAt, now() + ms); gapMs = 260;
            await sleep(ms); continue;
          }
          if (e && RETRY.has(e.code) && attempt + 1 < tries) { await sleep(500 * 2 ** attempt); attempt++; continue; }
          if (e && FATAL.has(e.code)) stopped = stopped || e;
          return done(id, e || new Error("Couldn't save"));
        }
      }
    }
    async function worker() {
      while (next < ids.length && !stopped) await one(ids[next++]);
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

    const saved = [], failed = [];
    for (const id of ids) {
      if (!outcome.has(id)) failed.push({ id, error: stopped });
      else if (outcome.get(id)) failed.push({ id, error: outcome.get(id) });
      else saved.push(id);
    }
    return { saved, failed, stopped };
  }

  const progressText = (settled, total) => `Saving ${settled} of ${total}…`;
  const partialText = (saved, total, failed, error) =>
    `Saved ${saved} of ${total}. ${failed} didn't save${error && error.message ? `: ${error.message}` : "."}`;

  root.BinderBulk = { run, progressText, partialText };
})(typeof window !== "undefined" ? window : globalThis);
