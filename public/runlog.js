/* The red banner for a price update that was interrupted (the server restarted or crashed during
   it), stalled (no progress for minutes) or failed partway: what happened, where it stopped, its
   log (the pricing and server lines from its start, oldest first, errors in red) and what can be
   done (stop it, start it again, copy the log, dismiss). The binder page and Administration →
   Prices both show it. A plain script: the pages use window.BinderRunLog, and the tests load it
   the same way. */
(function (root) {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const LEVEL = { info: "info ", warn: "WARN ", error: "ERROR" };

  /* "Oct 3, 05:12:09" in the given time zone (the browser's when none). */
  function time(iso, timeZone) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso ?? "");
    return new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d).replace(".", "");
  }

  /* One log entry as a line of text: time, level, category, message (and its details, if any). */
  function line(e, timeZone) {
    const data = e.data && Object.keys(e.data).length ? " " + JSON.stringify(e.data) : "";
    return `${time(e.at, timeZone)}  ${LEVEL[e.level] || e.level}  ${e.cat}  ${e.msg}${data}`;
  }

  /* The problem and its log as plain text, for copying into a message or a ticket. */
  function text(problem, entries, timeZone) {
    const head = problem ? [problem.title, problem.message, problem.recoveredAt ? `Since then ${recovered(problem, timeZone)}.` : null].filter(Boolean).concat("") : [];
    return [...head, ...(entries || []).map(e => line(e, timeZone))].join("\n");
  }

  function recovered(p, timeZone) {
    return p.kind === "stalled" && /moved on/.test(p.message) ? `it moved on at ${time(p.recoveredAt, timeZone)}` : `an update went through every card at ${time(p.recoveredAt, timeZone)}`;
  }

  /* The pill on the binder page: "Stuck 25/40", "Interrupted 25/40", or null when there's nothing wrong. */
  function stat(st) {
    const p = st && st.problem;
    if (!p || p.recoveredAt) return null;
    if (p.kind === "stalled" && st.running) return { label: "Stuck", count: `${p.done}/${p.total}` };
    if (st.running) return null; // a new update is running after the problem
    return { label: p.kind === "failed" ? "Failed" : p.kind === "stalled" ? "Stopped" : "Interrupted", count: `${p.done}/${p.total}` };
  }

  /* The banner. o: running (an update is running now), canEdit (may stop, start, dismiss),
     log: { entries, error } or null while loading (left out when it can't be seen), timeZone. */
  function banner(problem, o = {}) {
    if (!problem) return "";
    const p = problem, kind = p.recoveredAt ? "warn" : "bad";
    const btn = (act, label, cls = "") => `<button class="btn sm${cls}" type="button" data-runprob="${act}">${label}</button>`;
    const acts = o.canEdit ? [
      o.running ? btn("stop", "Stop the update", " danger solid") : btn("run", "Start it again", kind === "bad" ? " primary" : ""),
      o.log !== undefined ? btn("copy", "Copy log") : "",
      btn("dismiss", "Dismiss", " ghost"),
    ].join("") : "";
    const when = [p.startedAt ? `Started ${time(p.startedAt, o.timeZone)}` : "", `noticed ${time(p.at, o.timeZone)}`].filter(Boolean).join(", ");
    const later = p.recoveredAt ? `<p class="runprob-ok">Since then ${esc(recovered(p, o.timeZone))}.</p>` : "";
    let log = "";
    if (o.log !== undefined) {
      const l = o.log;
      const body = !l ? `<p class="hint">Loading the update's log…</p>`
        : l.error ? `<p class="hint">Couldn't load the log: ${esc(l.error)}</p>`
        : !l.entries.length ? `<p class="hint">No log lines from that time (logs are kept two weeks).</p>`
        : `<pre class="runlog" tabindex="0" aria-label="The update's log">${l.entries.map(e => `<span class="ll-${esc(e.level)}">${esc(line(e, o.timeZone))}</span>`).join("\n")}</pre>`;
      log = `<details class="runlog-box" open><summary>The update's log${l && l.entries && l.entries.length ? ` (${l.entries.length} line${l.entries.length === 1 ? "" : "s"}, newest last)` : ""}</summary>${body}</details>`;
    }
    return `<section class="runprob" data-kind="${kind}" role="alert" aria-labelledby="runprobTitle">
      <div class="runprob-head"><svg class="runprob-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18.2A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        <div><h2 id="runprobTitle">${esc(p.title)}</h2><p>${esc(p.message)}</p>${later}<p class="runprob-when">${esc(when)}</p></div></div>
      ${acts ? `<div class="links">${acts}</div>` : ""}
      ${log}
    </section>`;
  }

  /* A key that changes whenever the problem does (to know when to load its log again). */
  const key = p => (p ? [p.at, p.recoveredAt || "", p.message].join("|") : "");

  root.BinderRunLog = { banner, text, line, stat, key, time };
})(typeof window !== "undefined" ? window : globalThis);
