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
        /* once saving is known to be impossible, no card sends another request */
        if (stopped) return done(id, stopped);
        for (let w; (w = startAt - now()) > 0; ) await sleep(w);
        if (stopped) return done(id, stopped);
        /* the slot is taken with nothing awaited since the check, so two cards never share one */
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

  /* What the dialog needs after a run that left cards unsaved: the job for trying just those again,
     the cards left, the reason to show (why the run stopped, else the first card's) and the words;
     null when every card saved. */
  function retryJob(job, result) {
    if (!result.failed.length) return null;
    const left = result.failed.map(f => f.id), error = result.stopped || result.failed[0].error;
    /* counts run across the rounds: job.total is every card chosen, savedBefore those saved in earlier rounds */
    const savedBefore = (job.savedBefore || 0) + result.saved.length, total = job.total ?? job.ids.length;
    return { job: { ...job, ids: left, savedBefore }, left, error, text: partialText(savedBefore, total, left.length, error) };
  }

  const progressText = (settled, total) => `Saving ${settled} of ${total}…`;
  const partialText = (saved, total, failed, error) =>
    `Saved ${saved} of ${total}. ${failed} didn't save${error && error.message ? `: ${error.message}` : "."}`;

  root.BinderBulk = { run, retryJob, progressText, partialText };
})(typeof window !== "undefined" ? window : globalThis);
