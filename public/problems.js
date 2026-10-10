/* Every warning and error in the app, made hard to miss: the banner administrators see on the
   binder and in Administration (red for errors, amber for warnings only), the count in the
   header, the Problems list with repeats grouped, and the catcher that reports errors in the page
   itself to the server (where they're logged and join the list) and shows them on the page.
   A plain script: the pages use window.BinderProblems, and the tests load it the same way. */
(function (root) {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const CAT = { http: "Requests", auth: "Sign-in", admin: "Administration", security: "Security", pricing: "Prices", backup: "Backups", app: "Server" };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function time(iso, timeZone) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso ?? "");
    return new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(".", "");
  }

  /* "3 errors, 5 warnings" */
  function counts(feed) {
    return [feed.errors ? plural(feed.errors, "error", "errors") : "", feed.warnings ? plural(feed.warnings, "warning", "warnings") : ""].filter(Boolean).join(", ");
  }

  /* The header count: null when there's nothing new. */
  function pill(feed) {
    if (!feed || !(feed.errors + feed.warnings)) return null;
    return { kind: feed.errors ? "bad" : "warn", label: feed.errors ? plural(feed.errors, "error", "errors") : plural(feed.warnings, "warning", "warnings"), title: `${counts(feed)} since you last looked` };
  }

  /* One group as a line: when, how many times, where, what. */
  function row(g, timeZone) {
    const n = g.count > 1 ? `<span class="pb-n">${g.count}×</span> ` : "";
    const when = g.count > 1 ? `${time(g.first, timeZone)} – ${time(g.last, timeZone)}` : time(g.last, timeZone);
    const details = g.data && Object.keys(g.data).length ? `<details><summary>Details</summary><pre>${esc(JSON.stringify(g.data, null, 1))}</pre></details>` : "";
    return `<li class="pb-${g.level === "error" ? "error" : "warn"}"><span class="pb-lv">${g.level === "error" ? "Error" : "Warning"}</span><span class="pb-msg">${n}${esc(g.msg.split("\n")[0])}${details}</span><span class="pb-meta">${esc(CAT[g.cat] || g.cat)} · ${esc(when)}</span></li>`;
  }

  /* The banner: what's new since the problems were last marked as seen, the latest few, and what to do. */
  function banner(feed, o = {}) {
    if (!feed || !(feed.errors + feed.warnings)) return "";
    const kind = feed.errors ? "bad" : "warn";
    const top = feed.groups.slice(0, o.show ?? 3);
    const more = feed.groups.length - top.length;
    return `<section class="probs" data-kind="${kind}" role="${kind === "bad" ? "alert" : "status"}" aria-labelledby="probsTitle">
      <div class="probs-head"><svg class="probs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5h.01"/></svg>
        <h2 id="probsTitle">${esc(counts(feed))} ${feed.seenAt ? `since you last looked (${esc(time(feed.seenAt, o.timeZone))})` : "logged"}</h2></div>
      <ul class="pblist">${top.map(g => row(g, o.timeZone)).join("")}</ul>
      <div class="links">${more > 0 || o.showAll ? `<button class="btn sm" type="button" data-probs="all">Show all${more > 0 ? ` (${more} more)` : ""}</button>` : ""}<button class="btn sm" type="button" data-probs="copy">Copy</button><button class="btn sm${kind === "bad" ? " primary" : ""}" type="button" data-probs="seen">Mark as seen</button>${o.logsHref ? `<a class="btn sm ghost" href="${esc(o.logsHref)}">Open the Logs page</a>` : ""}</div>
    </section>`;
  }

  /* The full list (Show all). */
  function list(feed, o = {}) {
    if (!feed || !feed.groups.length) return `<p class="hint">Nothing has failed or warned${feed && feed.seenAt ? " since you last looked" : ""}.</p>`;
    return `<ul class="pblist full">${feed.groups.map(g => row(g, o.timeZone)).join("")}</ul>`;
  }

  /* As plain text, for copying into a message or a ticket. */
  function text(feed, timeZone) {
    if (!feed) return "";
    return [counts(feed) || "No problems", ...feed.groups.map(g => `${g.count > 1 ? `${time(g.first, timeZone)} – ${time(g.last, timeZone)} ${g.count}×` : time(g.last, timeZone)}  ${g.level === "error" ? "ERROR" : "WARN "}  ${g.cat}  ${g.msg}${g.data ? " " + JSON.stringify(g.data) : ""}`)].join("\n");
  }

  /* Errors in the page itself: each is reported (send) and shown (show), once per message every
     10 seconds and at most 20 per page load, so a loop can't flood either. Returns the handler, for the tests. */
  function catcher(win, o) {
    const seen = new Map();
    let sent = 0;
    const handle = (kind, message, extra = {}) => {
      const msg = String(message || "Unknown error").slice(0, 500);
      const t = Date.now();
      if (seen.has(msg) && t - seen.get(msg) < 10_000) return false;
      seen.set(msg, t);
      if (++sent > 20) return false;
      const report = { kind, message: msg, page: o.page || (win.location && win.location.pathname) || "", ...extra };
      try { o.show && o.show(msg); } catch (_) {}
      try { Promise.resolve(o.send && o.send(report)).catch(() => {}); } catch (_) {}
      return true;
    };
    win.addEventListener("error", e => {
      // A picture or script that didn't load fires an error without a message: not a script error.
      if (!e || !e.message) return;
      handle("error", e.message, { source: String(e.filename || "").slice(0, 300), line: e.lineno | 0, col: e.colno | 0, ...(e.error && e.error.stack ? { stack: String(e.error.stack).slice(0, 2000) } : {}) });
    });
    win.addEventListener("unhandledrejection", e => {
      const r = e && e.reason;
      handle("rejection", r && r.message ? r.message : String(r), r && r.stack ? { stack: String(r.stack).slice(0, 2000) } : {});
    });
    return handle;
  }

  root.BinderProblems = { banner, list, text, pill, row, counts, catcher, time };
})(typeof window !== "undefined" ? window : globalThis);
