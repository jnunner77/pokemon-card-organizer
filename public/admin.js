// Administration page: health and security checks, people, sign-in settings, API tokens,
// sessions, guests, backups, price updates, security and logs. Only administrators can open it.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const main = $("#main");
  const when = iso => iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";
  const day = iso => iso ? new Date(iso).toLocaleDateString("en-CA", { dateStyle: "medium" }) : "—";
  const size = b => b == null ? "—" : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`;
  let toastT;
  const toast = msg => { const r = $("#toastRoot"); r.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`; clearTimeout(toastT); toastT = setTimeout(() => r.innerHTML = "", 3200); };

  async function api(method, url, body) {
    const r = await fetch("api/" + url, { method, credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401) { location.replace("login.html"); throw new Error("Please sign in"); }
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `The server answered ${r.status}`);
    return data;
  }
  const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); await show(); return r; } catch (e) { toast(e.message); } };
  const formData = form => Object.fromEntries(new FormData(form).entries());

  const STATUS = { pass: "Passing", warn: "Needs attention", fail: "Failing", info: "Note" };
  const chip = (status, text) => `<span class="chip st-${esc(status)}">${esc(text ?? STATUS[status] ?? status)}</span>`;

  // ---- Overview ------------------------------------------------------------------------
  async function overview() {
    const o = await api("GET", "admin/overview");
    const n = s => o.checks.filter(c => c.status === s).length;
    const groups = [...new Set(o.checks.map(c => c.group))];
    return `<div class="adminhead"><div class="stats">
        <div class="stat"><span class="k">Failing</span><span class="v ${n("fail") ? "neg" : ""}">${n("fail")}</span></div>
        <div class="stat"><span class="k">Needs attention</span><span class="v">${n("warn")}</span></div>
        <div class="stat"><span class="k">Passing</span><span class="v pos">${n("pass")}</span></div>
        <div class="stat"><span class="k">Ledger</span><span class="v">${o.ledger.cards} <small>cards · ${o.ledger.binders} binders · ${o.ledger.photos} pictures (${size(o.ledger.bytes)})</small></span></div>
        <div class="stat"><span class="k">Server</span><span class="v">${esc(o.server.uptimeHours)} h <small>up · Node ${esc(o.server.node)}</small></span></div>
      </div><button class="btn sm" type="button" data-refresh>Check again</button></div>
      <p class="hint pad">Whether this server is ready for the public internet and healthy. Anything failing or needing attention says what to do.</p>
      ${groups.map(g => `<div class="checkgroup"><h3>${esc(g)}</h3><ul class="checks">${o.checks.filter(c => c.group === g).map(c => `<li class="check">${chip(c.status)}<div><b>${esc(c.title)}</b><p>${esc(c.detail)}</p>${c.fix ? `<p class="fix">${esc(c.fix)}</p>` : ""}</div></li>`).join("")}</ul></div>`).join("")}`;
  }

  // ---- People --------------------------------------------------------------------------
  const ROLE_TEXT = { admin: "Administrator: everything, including this page", editor: "Editor: changes the ledger", viewer: "Viewer: looks only" };
  const roleOptions = sel => ["admin", "editor", "viewer"].map(r => `<option value="${r}" ${r === sel ? "selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("");
  async function people() {
    const { users, settings } = await api("GET", "admin/users");
    const rows = users.map(u => `<tr data-user="${esc(u.id)}">
      <td class="cellname"><b>${esc(u.name)}</b><span class="mono">${esc(u.username)}</span></td>
      <td><select data-role aria-label="Role for ${esc(u.username)}">${roleOptions(u.role)}</select></td>
      <td>${u.active ? chip("pass", "Active") : chip("info", "Inactive")}${u.mustChange ? " " + chip("warn", "Temporary password") : ""}${u.lockedUntil ? " " + chip("fail", "Locked until " + when(u.lockedUntil)) : ""}</td>
      <td class="mono">${when(u.lastSignInAt)}</td>
      <td class="r mono">${u.sessions}</td>
      <td class="acts"><button class="btn sm" type="button" data-pw>Set password</button><button class="btn sm" type="button" data-active>${u.active ? "Deactivate" : "Activate"}</button><button class="btn sm" type="button" data-signout ${u.sessions ? "" : "disabled"}>Sign out</button><button class="btn sm danger" type="button" data-remove>Remove</button></td></tr>`).join("");
    return `<div class="tablewrap"><table><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last sign-in</th><th class="r">Sessions</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint pad">${Object.values(ROLE_TEXT).map(esc).join(" · ")}</p>
      <form class="adminform" id="addUser"><h3>Add a person</h3>
        <div class="form">
          <div class="field"><label for="u_name">Name</label><input id="u_name" name="name" required maxlength="80"></div>
          <div class="field"><label for="u_user">Username</label><input id="u_user" name="username" required pattern="[a-zA-Z0-9._\\-]{2,32}" autocapitalize="none" spellcheck="false"></div>
          <div class="field"><label for="u_role">Role</label><select id="u_role" name="role">${roleOptions("editor")}</select></div>
          <div class="field"><label for="u_pw">Temporary password</label><input id="u_pw" name="password" type="password" required minlength="${settings.passwordMinLength}" autocomplete="new-password"></div>
        </div>
        <label class="check-inline"><input type="checkbox" name="mustChange" checked> They choose their own password when they first sign in</label>
        <div class="formfoot"><span class="hint">Give them the password another way (in person, or a message you then delete).</span><button class="btn primary" type="submit">Add person</button></div>
      </form>`;
  }
  function wirePeople() {
    main.querySelectorAll("tr[data-user]").forEach(tr => {
      const id = tr.dataset.user, name = tr.querySelector(".mono").textContent;
      tr.querySelector("[data-role]").onchange = e => act(() => api("PATCH", `admin/users/${id}`, { role: e.target.value }), `${name} is now ${e.target.value === "admin" ? "an administrator" : e.target.value === "editor" ? "an editor" : "a viewer"}`);
      tr.querySelector("[data-active]").onclick = e => act(() => api("PATCH", `admin/users/${id}`, { active: e.target.textContent === "Activate" }), "Saved");
      tr.querySelector("[data-signout]").onclick = () => act(() => api("POST", `admin/users/${id}/signout`), `${name} is signed out everywhere`);
      tr.querySelector("[data-pw]").onclick = () => {
        const pw = prompt(`New temporary password for ${name}. They'll choose their own when they sign in.`);
        if (pw) act(() => api("POST", `admin/users/${id}/password`, { password: pw, mustChange: true }), `Password set; ${name} is signed out everywhere`);
      };
      tr.querySelector("[data-remove]").onclick = () => { if (confirm(`Remove ${name}? Their sessions and API tokens end too.`)) act(() => api("DELETE", `admin/users/${id}`), `${name} removed`); };
    });
    $("#addUser").onsubmit = e => {
      e.preventDefault();
      const d = formData(e.target);
      act(() => api("POST", "admin/users", { name: d.name, username: d.username, role: d.role, password: d.password, mustChange: !!d.mustChange }), `${d.username} added`);
    };
  }

  // ---- Sign-in settings ----------------------------------------------------------------
  async function signin() {
    const { settings: s } = await api("GET", "admin/users");
    const f = (id, label, v, min, max, hint) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="number" min="${min}" max="${max}" value="${esc(v)}" class="mono" required><span class="hint">${hint}</span></div>`;
    return `<form class="adminform" id="settingsForm"><h3>Sign-in settings</h3><div class="form">
      ${f("sessionIdleHours", "Sign out after this many hours unused", s.sessionIdleHours, 1, 2160, "Default 336 (two weeks).")}
      ${f("sessionMaxDays", "Sign out after this many days regardless", s.sessionMaxDays, 1, 365, "Default 30.")}
      ${f("passwordMinLength", "Shortest password allowed", s.passwordMinLength, 8, 64, "10 or more is recommended.")}
      ${f("lockoutAfter", "Wrong passwords before a username is locked", s.lockoutAfter, 3, 20, "Default 5.")}
      ${f("lockoutMinutes", "First lock, in minutes", s.lockoutMinutes, 1, 60, "Each further lock lasts twice as long, up to a day.")}
    </div><div class="formfoot"><span class="hint">Passwords are stored as scrypt hashes. Addresses that keep failing are also blocked (see Security).</span><button class="btn primary" type="submit">Save</button></div></form>`;
  }
  function wireSignin() {
    $("#settingsForm").onsubmit = e => { e.preventDefault(); const d = formData(e.target); act(() => api("PUT", "admin/settings", Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Number(v)]))), "Sign-in settings saved"); };
  }

  // ---- API tokens ----------------------------------------------------------------------
  let newToken = null;
  async function tokens() {
    const [{ tokens }, { users }] = await Promise.all([api("GET", "admin/tokens"), api("GET", "admin/users")]);
    const rows = tokens.map(t => `<tr><td class="cellname"><b>${esc(t.name)}</b><span class="mono">${esc(t.prefix)}…</span></td><td>${esc(t.user)}</td><td>${t.scope === "write" ? "Read & write" : "Read only"}</td><td class="mono">${day(t.createdAt)}</td><td class="mono">${t.expired ? chip("fail", "Expired") : day(t.expiresAt)}</td><td class="mono">${when(t.lastUsedAt)}</td><td><button class="btn sm danger" type="button" data-revoke="${esc(t.id)}">Revoke</button></td></tr>`).join("");
    const shown = newToken ? `<div class="banner" data-kind="warn"><b>Copy this token now; it won't be shown again.</b><div class="tokenrow"><code class="mono" id="tokenText">${esc(newToken)}</code><button class="btn sm" type="button" id="copyToken">Copy</button></div><span class="hint">Send it as <code>Authorization: Bearer &lt;token&gt;</code>.</span></div>` : "";
    newToken = null;
    return `${shown}<div class="tablewrap"><table><thead><tr><th>Token</th><th>Acts as</th><th>Access</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty-state">No API tokens.</td></tr>`}</tbody></table></div>
      <form class="adminform" id="addToken"><h3>Create an API token</h3><p class="hint">For scripts and assistants. A token acts as one person, never with administrator rights, and always expires.</p><div class="form">
        <div class="field"><label for="t_name">Name</label><input id="t_name" name="name" required maxlength="80" placeholder="e.g. Price script"></div>
        <div class="field"><label for="t_user">Acts as</label><select id="t_user" name="userId">${users.filter(u => u.active).map(u => `<option value="${esc(u.id)}">${esc(u.name)} (${esc(u.username)})</option>`).join("")}</select></div>
        <div class="field"><label for="t_scope">Access</label><select id="t_scope" name="scope"><option value="read">Read only</option><option value="write">Read & write</option></select></div>
        <div class="field"><label for="t_days">Expires after (days)</label><input id="t_days" name="expiresInDays" type="number" min="1" max="365" value="90" class="mono"></div>
      </div><div class="formfoot"><span></span><button class="btn primary" type="submit">Create token</button></div></form>`;
  }
  function wireTokens() {
    main.querySelectorAll("[data-revoke]").forEach(b => b.onclick = () => { if (confirm("Revoke this token? Anything using it stops working.")) act(() => api("DELETE", `admin/tokens/${b.dataset.revoke}`), "Token revoked"); });
    $("#addToken").onsubmit = async e => {
      e.preventDefault();
      const d = formData(e.target);
      const r = await act(() => api("POST", "admin/tokens", { name: d.name, userId: d.userId, scope: d.scope, expiresInDays: Number(d.expiresInDays) }).then(x => { newToken = x.token; return x; }));
      if (r) toast("Token created");
    };
    const copy = $("#copyToken");
    if (copy) copy.onclick = () => navigator.clipboard?.writeText($("#tokenText").textContent).then(() => toast("Copied"), () => toast("Couldn't copy; select it instead."));
  }

  // ---- Sessions ------------------------------------------------------------------------
  async function sessions() {
    const { sessions } = await api("GET", "admin/sessions");
    const rows = sessions.map(s => `<tr><td>${esc(s.user)}</td><td class="mono">${esc(s.ip)}</td><td class="agent">${esc(s.agent)}</td><td class="mono">${when(s.createdAt)}</td><td class="mono">${when(s.lastSeen)}</td><td><button class="btn sm" type="button" data-end="${esc(s.id)}">End</button></td></tr>`).join("");
    return `<div class="tablewrap"><table><thead><tr><th>Person</th><th>Address</th><th>Browser</th><th>Signed in</th><th>Last used</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty-state">No one is signed in.</td></tr>`}</tbody></table></div>`;
  }
  function wireSessions() {
    main.querySelectorAll("[data-end]").forEach(b => b.onclick = () => act(() => api("DELETE", `admin/sessions/${b.dataset.end}`), "Session ended"));
  }

  // ---- Guests --------------------------------------------------------------------------
  const ENDED = { signout: "Signed out", timeout: "Timed out", admin: "Ended here", closed: "Guest viewing turned off", replaced: "Signed in again", restart: "Server restarted" };
  let guestData = null;
  async function guests() {
    const g = guestData = await api("GET", "admin/guests?base=" + encodeURIComponent(location.href));
    const contact = v => `<a href="${v.contactKind === "email" ? "mailto:" : "tel:"}${esc(v.contact)}">${esc(v.contact)}</a>`;
    const active = g.active.map(v => `<tr><td><b>${esc(v.name)}</b></td><td>${contact(v)}</td><td class="mono">${when(v.startedAt)}</td><td class="mono">${when(v.lastSeenAt)}</td><td class="mono">${esc(v.ip)}</td><td><button class="btn sm" type="button" data-gend="${esc(v.id)}">End</button></td></tr>`).join("");
    const visits = g.log.map(v => `<tr><td><b>${esc(v.name)}</b></td><td>${contact(v)}</td><td class="mono">${when(v.startedAt)}</td><td class="mono">${when(v.lastSeenAt)}</td><td>${v.ended ? esc(ENDED[v.ended] || v.ended) : chip("pass", "Looking now")}</td></tr>`).join("");
    return `<div class="adminhead"><div class="stats">
        <div class="stat"><span class="k">Guest viewing</span><span class="v ${g.enabled ? "pos" : ""}">${g.enabled ? "On" : "Off"}</span></div>
        <div class="stat"><span class="k">Listed for sale</span><span class="v">${g.listed} <small>card${g.listed === 1 ? "" : "s"}</small></span></div>
        <div class="stat"><span class="k">Looking now</span><span class="v">${g.active.length}</span></div>
        <div class="stat"><span class="k">Visits logged</span><span class="v">${g.log.length}</span></div>
      </div><button class="btn ${g.enabled ? "" : "primary"}" type="button" id="guestToggle">${g.enabled ? "Turn guest viewing off" : "Turn guest viewing on"}</button></div>
      <div class="adminform"><h3>QR code</h3>
        <div class="qrbox"><div class="qrcode" aria-label="QR code for the guest page" role="img">${g.qr}</div>
          <div class="qrinfo">
            <p class="hint">Guests scan this to look through every card marked <b>Listed for sale</b>. They give their name and a phone number or email, see only those cards (details, picture, and market value rounded up to the dollar, nothing else in the ledger), and are signed out after ${g.idleMinutes} minutes without use. No two guests at once share a name or a phone number or email.</p>
            ${g.enabled ? "" : `<p>${chip("warn", "Guest viewing is off")} <span class="hint">The code says guest viewing is closed until you turn it on.</span></p>`}
            <span class="qrlink" id="guestUrl">${esc(g.url)}</span>
            <div class="tokenrow"><button class="btn primary" type="button" id="qrPrint">Print</button><a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener">Open the guest page</a><button class="btn" type="button" id="qrCopy">Copy link</button><button class="btn danger" type="button" id="qrNew">New QR code</button></div>
            <p class="hint">A new QR code makes the ones already printed or shared stop working (made ${when(g.keyCreatedAt)}). Guests looking now stay signed in. Turning guest viewing off signs every guest out.</p>
          </div></div></div>
      <h3 class="pad">Looking now</h3>
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Phone or email</th><th>Signed in</th><th>Last active</th><th>Address</th><th></th></tr></thead><tbody>${active || `<tr><td colspan="6" class="empty-state">No guests are looking right now.</td></tr>`}</tbody></table></div>
      <h3 class="pad">Guest log</h3>
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Phone or email</th><th>Signed in</th><th>Last active</th><th>Ended</th></tr></thead><tbody>${visits || `<tr><td colspan="5" class="empty-state">No guests yet.</td></tr>`}</tbody></table></div>
      <div class="formfoot pad"><span class="hint">Kept on this server only (not in backups), the newest 2,000 visits.</span><button class="btn sm danger" type="button" id="guestClear" ${g.log.length ? "" : "disabled"}>Clear the log</button></div>`;
  }
  function wireGuests() {
    const g = guestData;
    $("#guestToggle").onclick = () => {
      if (g.enabled && g.active.length && !confirm(`Turn guest viewing off? The ${g.active.length} guest${g.active.length === 1 ? "" : "s"} looking now will be signed out.`)) return;
      act(() => api("PUT", "admin/guests", { enabled: !g.enabled }), g.enabled ? "Guest viewing is off" : "Guest viewing is on");
    };
    $("#qrNew").onclick = () => { if (confirm("Make a new QR code? Codes already printed or shared stop working. Guests looking now stay signed in.")) act(() => api("POST", "admin/guests/key"), "New QR code made; print it again"); };
    $("#qrCopy").onclick = () => navigator.clipboard?.writeText(g.url).then(() => toast("Link copied"), () => toast("Couldn't copy; select the link instead."));
    $("#qrPrint").onclick = () => {
      const sheet = document.createElement("div");
      sheet.className = "qrprint";
      sheet.innerHTML = `<h1>Cards for sale</h1><p>Scan with your phone's camera to look through them.</p><div class="qrcode">${g.qr}</div>`;
      document.body.append(sheet);
      document.body.classList.add("printing-qr");
      const done = () => { document.body.classList.remove("printing-qr"); sheet.remove(); window.removeEventListener("afterprint", done); };
      window.addEventListener("afterprint", done);
      window.print();
      setTimeout(done, 1000);
    };
    main.querySelectorAll("[data-gend]").forEach(b => b.onclick = () => act(() => api("DELETE", `admin/guests/sessions/${b.dataset.gend}`), "Guest signed out"));
    $("#guestClear").onclick = () => { if (confirm("Clear the guest log? Names and phone numbers or emails of past guests are deleted for good.")) act(() => api("DELETE", "admin/guests/log"), "Guest log cleared"); };
  }

  // ---- Backups -------------------------------------------------------------------------
  const KIND = { daily: "Daily", snapshot: "Snapshot", "before-restore": "Before a restore" };
  async function backups() {
    const b = await api("GET", "admin/backups");
    const r = b.retention;
    const rows = b.backups.map(x => `<tr><td>${chip(x.kind === "snapshot" ? "pass" : "info", KIND[x.kind])}${x.label ? ` <span class="hint">${esc(x.label)}</span>` : ""}</td><td class="mono">${x.kind === "daily" ? day(x.at) : when(x.at)}</td><td class="r mono">${size(x.bytes)}</td><td class="acts"><a class="btn sm" href="api/admin/backups/${encodeURIComponent(x.name)}">Download</a><button class="btn sm" type="button" data-restore="${esc(x.name)}">Restore</button><button class="btn sm danger" type="button" data-delete="${esc(x.name)}">Delete</button></td></tr>`).join("");
    return `<div class="adminform"><h3>Full backup</h3><p class="hint">Every binder, card, price and picture in one file: the copy to keep somewhere other than this server. Last downloaded: <b>${when(b.lastFullBackupAt)}</b>.</p><a class="btn primary" href="api/backup">Download full backup</a></div>
      <form class="adminform" id="snapForm"><h3>Copies on the server</h3><p class="hint">The ledger is copied every day; older copies thin out (days, then weeks, then months). Restoring keeps the current ledger as a copy first, and deleted pictures come back (they are kept 400 days). Pictures: ${b.photos.photos} (${size(b.photos.bytes)}), ${b.photos.trashed} deleted kept.</p>
        <div class="tokenrow"><input name="label" maxlength="40" placeholder="Label (optional), e.g. Before reorganizing" aria-label="Snapshot label"><button class="btn" type="submit">Take a snapshot now</button></div></form>
      <div class="tablewrap"><table><thead><tr><th>Copy</th><th>Taken</th><th class="r">Size</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty-state">No copies yet.</td></tr>`}</tbody></table></div>
      <form class="adminform" id="retForm"><h3>How long copies are kept</h3><div class="form">
        <div class="field"><label for="r_d">Daily copies</label><input id="r_d" name="daily" type="number" min="1" max="60" value="${r.daily}" class="mono"></div>
        <div class="field"><label for="r_w">Plus one per week, for weeks</label><input id="r_w" name="weekly" type="number" min="0" max="52" value="${r.weekly}" class="mono"></div>
        <div class="field"><label for="r_m">Plus one per month, for months</label><input id="r_m" name="monthly" type="number" min="0" max="60" value="${r.monthly}" class="mono"></div>
      </div><div class="formfoot"><span class="hint">Snapshots are kept until you delete them (up to 50).</span><button class="btn" type="submit">Save</button></div></form>`;
  }
  function wireBackups() {
    main.querySelectorAll("[data-restore]").forEach(b => b.onclick = () => { if (confirm(`Replace the whole ledger with the copy ${b.dataset.restore}? The current ledger is kept as a copy first.`)) act(() => api("POST", `admin/backups/${encodeURIComponent(b.dataset.restore)}/restore`), "Ledger restored"); });
    main.querySelectorAll("[data-delete]").forEach(b => b.onclick = () => { if (confirm(`Delete the copy ${b.dataset.delete}?`)) act(() => api("DELETE", `admin/backups/${encodeURIComponent(b.dataset.delete)}`), "Copy deleted"); });
    $("#snapForm").onsubmit = e => { e.preventDefault(); act(() => api("POST", "admin/backups/snapshot", { label: formData(e.target).label || undefined }), "Snapshot taken"); };
    $("#retForm").onsubmit = e => { e.preventDefault(); const d = formData(e.target); act(() => api("PUT", "admin/backups/retention", { daily: +d.daily, weekly: +d.weekly, monthly: +d.monthly }), "Retention saved"); };
  }

  // ---- Prices --------------------------------------------------------------------------
  /* How PriceCharting is being used today, against its rules: one call a second, a daily budget, and whether it's paused. */
  function pcUsage(u) {
    if (!u) return "";
    const pct = u.limit ? Math.min(100, Math.round(u.calls / u.limit * 100)) : 0;
    const paused = u.pausedUntil ? `<div class="probs" data-kind="bad" role="alert" style="margin:8px 0"><div class="probs-head"><h2>PriceCharting isn't being asked until ${esc(when(u.pausedUntil))}</h2></div><p>${esc(u.pausedWhy || "")}</p><p class="hint">This protects the subscription: PriceCharting blocks, then revokes, an account that asks too often. Prices come from TCGplayer and Cardmarket meanwhile, and it's asked again by itself afterwards.</p></div>` : "";
    return `${paused}<p class="pcusage"><span><b>${u.calls}</b> of ${u.limit} calls today (UTC)</span><span class="meter" role="img" aria-label="${pct}% of today's calls used"><span style="width:${pct}%" class="${pct >= 80 ? "hi" : ""}"></span></span><span class="hint">at most one every ${(u.gapMs / 1000).toFixed(2)} s, retries included${u.cached ? ` · ${u.cached} recent answers reused` : ""}${u.failuresInARow ? ` · ${u.failuresInARow} failed in a row` : ""}${u.lastCallAt ? ` · last call ${esc(when(u.lastCallAt))}` : ""}</span></p>`;
  }
  let problemLog = null;
  async function prices() {
    const p = await api("GET", "admin/pricing");
    if (!p.available) return `<p class="empty-state">Automatic prices aren't available on this server.</p>`;
    const s = p.schedule;
    // An update that was interrupted, stalled or failed: the red banner, with the update's log.
    let problem = "";
    if (p.problem) {
      const log = await api("GET", "pricing/log").then(r => ({ entries: r.entries || [] }), e => ({ error: e.message }));
      problemLog = log;
      problem = window.BinderRunLog.banner(p.problem, { running: p.running, canEdit: true, log });
    }
    const ENDED = { interrupted: "Interrupted", stopped: "Stopped", failed: "Failed" };
    const rows = p.history.map(h => { const c = h.counts || {}; const mins = h.finishedAt && h.startedAt ? Math.max(1, Math.round((Date.parse(h.finishedAt) - Date.parse(h.startedAt)) / 60000)) : "—"; return `<tr${h.ended ? ` class="ended"` : ""}><td class="mono">${esc(h.date)}${h.ended ? ` ${chip(h.ended === "stopped" ? "warn" : "fail", `${ENDED[h.ended] || h.ended} at ${(h.done ?? 0) + (h.done < h.total ? 1 : 0)} of ${h.total ?? "?"}`)}` : ""}</td><td>${h.reason === "manual" ? "Started by someone" : "Daily"}</td><td class="r mono">${c.updated ?? 0}</td><td class="r mono">${c.needsMatch ?? 0}</td><td class="r mono">${c.noPrice ?? 0}</td><td class="r mono ${c.failed ? "neg" : ""}">${c.failed ?? 0}</td><td class="r mono">${Number(h.rate) ? Number(h.rate).toFixed(4) : "—"}</td><td class="r mono">${mins} min</td></tr>${h.sitesOut ? `<tr class="errrow"><td colspan="8">${Object.values(h.sitesOut).map(esc).join("<br>")}</td></tr>` : ""}${h.errors && h.errors.length ? `<tr class="errrow"><td colspan="8">${h.errors.map(e => `<b>${esc(e.card)}</b>: ${esc(e.error)}`).join("<br>")}</td></tr>` : ""}`; }).join("");
    const pc = p.pricecharting;
    return `${problem}<form class="adminform" id="schedForm"><h3>Daily price update</h3><div class="form">
        <div class="field"><label for="p_on">Runs every day</label><select id="p_on" name="enabled"><option value="1" ${s.enabled ? "selected" : ""}>Yes</option><option value="0" ${s.enabled ? "" : "selected"}>No (only when started by hand)</option></select></div>
        <div class="field"><label for="p_hour">After this hour (${esc(s.timeZone)})</label><input id="p_hour" name="hour" type="number" min="0" max="23" value="${s.hour}" class="mono"></div>
        <div class="field"><label for="p_cm">Compare Cardmarket (Europe)</label><select id="p_cm" name="cardmarket"><option value="1" ${s.cardmarket ? "selected" : ""}>Yes</option><option value="0" ${s.cardmarket ? "" : "selected"}>No</option></select></div>
      </div><p class="hint">Each card is priced at the highest of PriceCharting's ungraded price, TCGplayer's market price and Cardmarket's trend; a graded card at PriceCharting's price for its grade. PriceCharting's prices come from its API; TCGplayer's and Cardmarket's from the TCGdex card database. No site's pages are read. Pictures come from pokemontcg.io (733×1024), TCGplayer or TCGdex.</p><div class="formfoot"><span class="hint">${p.running ? `Running now: ${p.done} of ${p.total} cards${p.current?.card ? ` (now ${esc(p.current.card)})` : ""}.` : "If the server was off at that hour, it runs when it's back."}</span><span style="display:flex;gap:8px">${p.running && !p.problem ? `<button class="btn danger" type="button" data-runprob="stop">Stop the update</button>` : ""}<button class="btn" type="button" id="runNow" ${p.running ? "disabled" : ""}>Update all prices now</button><button class="btn primary" type="submit">Save</button></span></div></form>
      ${pc ? `<form class="adminform" id="pcForm" autocomplete="off"><h3>PriceCharting</h3>
        <p>${pc.set ? `${chip("pass", "API token saved")} <span class="hint">on ${esc(when(pc.savedAt))}</span>` : chip("info", "No API token")}</p>
        ${pcUsage(pc.usage)}
        <p class="hint">PriceCharting's prices (ungraded, and graded when the subscription includes them) come from its API with your subscription's token: on PriceCharting, <b>Subscription → API/Download</b>. The token is kept in its own file on the server, apart from the ledger: it's never shown here again, logged, or put in backups or exports. PriceCharting is asked at most once a second.${pc.set ? "" : " Without a token, prices come from TCGplayer and Cardmarket only."}</p>
        <div class="tokenrow"><input name="token" type="password" maxlength="100" spellcheck="false" autocapitalize="off" placeholder="${pc.set ? "Paste a new token to replace it" : "Paste the 40-character token"}" aria-label="PriceCharting API token" required><button class="btn primary" type="submit">${pc.set ? "Replace token" : "Save token"}</button></div>
        <div class="formfoot"><span class="hint">Subscription ended? Purging removes the token and everything that came from PriceCharting: its matches, its prices in the daily price log (each day keeps the other sources' highest, or is removed) and its pictures (others are downloaded at the next update). Prices you logged yourself stay. Copies of the ledger on the server still hold PriceCharting's prices until they age out, as set under Backups.</span><span style="display:flex;gap:8px;flex-wrap:wrap">${pc.set ? `<button class="btn" type="button" id="pcRemove">Remove token</button>` : ""}<button class="btn danger" type="button" id="pcPurge">Purge PriceCharting data</button></span></div></form>` : ""}
      <h3 class="pad">Recent updates</h3>
      <div class="tablewrap"><table><thead><tr><th>Date</th><th>How</th><th class="r">Updated</th><th class="r">Need a match</th><th class="r">No price</th><th class="r">Failed</th><th class="r">USD→CAD</th><th class="r">Took</th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="empty-state">No updates yet.</td></tr>`}</tbody></table></div>`;
  }
  function wirePrices() {
    const f = $("#schedForm"); if (!f) return;
    f.onsubmit = e => { e.preventDefault(); const d = formData(e.target); act(() => api("PUT", "admin/pricing", { enabled: d.enabled === "1", hour: Number(d.hour), cardmarket: d.cardmarket === "1" }), "Schedule saved"); };
    $("#runNow").onclick = () => act(() => api("POST", "pricing/run"), "Price update started; it takes a few minutes");
    main.querySelectorAll(".runlog").forEach(pre => { pre.scrollTop = pre.scrollHeight; });
    main.querySelectorAll("[data-runprob]").forEach(b => b.onclick = async () => {
      const a = b.dataset.runprob;
      if (a === "copy") {
        const txt = window.BinderRunLog.text((await api("GET", "admin/pricing")).problem, problemLog?.entries || []);
        try { await navigator.clipboard.writeText(txt); toast("Log copied"); } catch { toast("Couldn't copy: select the log and copy it instead."); }
        return;
      }
      b.disabled = true;
      act(() => api("POST", { stop: "pricing/stop", run: "pricing/run", dismiss: "pricing/dismiss" }[a]), { stop: "Update stopped", run: "Price update started; it takes a few minutes", dismiss: "Dismissed" }[a]);
    });
    const pc = $("#pcForm"); if (!pc) return;
    pc.onsubmit = e => { e.preventDefault(); const input = e.target.elements.token; const token = input.value.trim(); input.value = ""; act(() => api("PUT", "admin/pricing/pricecharting-token", { token }), "PriceCharting accepted the token; it's saved"); };
    const rm = $("#pcRemove");
    if (rm) rm.onclick = () => { if (confirm("Remove PriceCharting's API token? Prices then come from TCGplayer and Cardmarket only; PriceCharting's past prices stay.")) act(() => api("DELETE", "admin/pricing/pricecharting-token"), "Token removed"); };
    $("#pcPurge").onclick = () => {
      if (!confirm("Purge everything that came from PriceCharting? This removes the token, every card's PriceCharting match, PriceCharting's prices in the daily price log and its pictures. It can't be undone (except by restoring a copy).")) return;
      act(async () => { const r = await api("POST", "admin/pricing/purge-pricecharting"); toast(`Purged: ${r.cards} cards, ${r.prices} daily prices (${r.removed} removed), ${r.pictures} pictures`); return r; });
    };
  }

  // ---- Security ------------------------------------------------------------------------
  async function security() {
    const s = await api("GET", "admin/security");
    if (!s.enabled) return `<p class="empty-state">Rate limiting is off on this server.</p>`;
    const L = s.limits, lim = (k, l) => `<tr><td>${esc(k)}</td><td class="r mono">${l.burst}</td><td class="r mono">${l.perMinute}</td></tr>`;
    const bans = s.bans.map(b => `<tr><td class="mono">${esc(b.ip)}</td><td>${esc(b.reason)}</td><td class="mono">${when(b.until)}</td><td class="r mono">${b.strikes}</td><td><button class="btn sm" type="button" data-unban="${esc(b.ip)}">Unblock</button></td></tr>`).join("");
    const events = s.events.map(e => `<li><span class="mono">${when(e.at)}</span> ${chip(e.level === "warn" ? "warn" : e.level === "error" ? "fail" : "info", e.level)} ${esc(e.msg)}</li>`).join("");
    return `<div class="adminhead"><div class="stats">
        <div class="stat"><span class="k">Requests limited</span><span class="v">${s.stats.limited}</span></div>
        <div class="stat"><span class="k">Addresses blocked</span><span class="v">${s.stats.blocked}</span></div>
        <div class="stat"><span class="k">Refused while blocked</span><span class="v">${s.stats.refused}</span></div>
        <div class="stat"><span class="k">Live connections</span><span class="v">${s.streamsOpen}</span></div>
      </div><span class="hint">Since the server started.</span></div>
      <h3 class="pad">Blocked now</h3>
      <div class="tablewrap"><table><thead><tr><th>Address</th><th>Why</th><th>Until</th><th class="r">Blocks today</th><th></th></tr></thead><tbody>${bans || `<tr><td colspan="5" class="empty-state">No one is blocked.</td></tr>`}</tbody></table></div>
      <p class="hint pad">An address is blocked after ${L.ban.violations} over-limit requests, ${L.ban.authFailures} failed sign-ins or ${L.ban.notFound} requests for missing API paths within ${Math.round(L.ban.windowMs / 60000)} minutes. The first block lasts ${Math.round(L.ban.durationMs / 60000)} minutes and each further one that day twice as long, up to ${Math.round(L.ban.maxDurationMs / 3600000)} hours.${s.allowlist.filter(Boolean).length ? ` Never limited: ${s.allowlist.filter(Boolean).map(esc).join(", ")}.` : ""}</p>
      <h3 class="pad">Limits</h3>
      <div class="tablewrap"><table><thead><tr><th>What</th><th class="r">At once</th><th class="r">Per minute</th></tr></thead><tbody>
        ${lim("Every request, per address", L.ip)}${lim("Before signing in, per address", L.anonymous)}${lim("Signed in, per person", L.user)}${lim("Changes, per person", L.mutations)}${lim("Sign-in attempts, per address", L.signIn)}${lim("Backups, restores and price operations, per person", L.heavy)}${L.guest ? lim("Guests, per guest", L.guest) + lim("Guest sign-ins, per address", L.guestSignIn) : ""}
      </tbody></table></div>
      <h3 class="pad">Recent security events</h3><ul class="events">${events || `<li class="hint">None.</li>`}</ul>`;
  }
  function wireSecurity() {
    main.querySelectorAll("[data-unban]").forEach(b => b.onclick = () => act(() => api("DELETE", `admin/security/bans/${encodeURIComponent(b.dataset.unban)}`), `${b.dataset.unban} unblocked`));
  }

  // ---- Problems: every warning and error since they were last marked as seen -------------
  let probFeed = null, probAll = false, pageErrors = [];
  async function loadProblems() {
    try { probFeed = await api("GET", "admin/problems"); } catch (e) { console.warn("Couldn't load the problems", e); }
    renderProbsBanner();
  }
  function renderProbsBanner() {
    const el = $("#probsBanner");
    const pe = pageErrors.length ? `<section class="probs" data-kind="bad" role="alert"><div class="probs-head"><h2>Something went wrong in this page${pageErrors.length > 1 ? ` (${pageErrors.length} times)` : ""}</h2></div><p>${esc(pageErrors[pageErrors.length - 1])}</p><p class="hint">It was logged. Reloading the page usually clears it.</p><div class="links"><button class="btn sm primary" type="button" data-pageerr="reload">Reload the page</button><button class="btn sm ghost" type="button" data-pageerr="dismiss">Dismiss</button></div></section>` : "";
    // On the Problems tab the list itself is the banner.
    const h = pe + (location.hash === "#problems" ? "" : window.BinderProblems.banner(probFeed, { logsHref: "#logs" }));
    if (el.dataset.html === h) return;
    el.innerHTML = h; el.dataset.html = h;
  }
  async function problemsAct(a) {
    if (a === "all") { location.hash = "#problems"; return; }
    const feed = probAll ? await api("GET", "admin/problems?all=1") : probFeed;
    if (a === "copy") {
      try { await navigator.clipboard.writeText(window.BinderProblems.text(feed)); toast("Copied"); } catch { toast("Couldn't copy: use the Logs page's daily files instead."); }
      return;
    }
    if (a === "seen") {
      try { probFeed = await api("POST", "admin/problems/seen", { upTo: probFeed?.latest || undefined }); toast("Marked as seen"); } catch (e) { toast(e.message); }
      renderProbsBanner();
      if (location.hash === "#problems") show();
    }
  }
  async function problems() {
    const feed = probAll ? await api("GET", "admin/problems?all=1") : (probFeed = await api("GET", "admin/problems"));
    renderProbsBanner();
    return `<div class="adminhead"><p class="hint" style="margin:0">${feed.errors + feed.warnings ? `<b>${esc(window.BinderProblems.counts(feed))}</b> ${probAll ? "in the last two weeks" : feed.seenAt ? `since they were last marked as seen (${esc(when(feed.seenAt))})` : "logged"}.` : "Nothing has failed or warned" + (probAll ? " in the last two weeks." : " since they were last marked as seen.")} Repeats are grouped; the Logs page has every line.</p>
        <span class="links"><label class="phswitch"><input type="checkbox" id="probAll" ${probAll ? "checked" : ""}><span>Include ones already seen</span></label><button class="btn sm" type="button" data-probs="copy">Copy</button>${probAll ? "" : `<button class="btn sm primary" type="button" data-probs="seen" ${feed.errors + feed.warnings ? "" : "disabled"}>Mark as seen</button>`}</span></div>
      <div class="pad">${window.BinderProblems.list(feed)}</div>`;
  }
  function wireProblems() {
    $("#probAll").onchange = e => { probAll = e.target.checked; show(); };
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-probs]"); if (b) return void problemsAct(b.dataset.probs);
    const pe = e.target.closest("[data-pageerr]"); if (pe) { if (pe.dataset.pageerr === "reload") location.reload(); else { pageErrors = []; renderProbsBanner(); } }
  });
  window.BinderProblems.catcher(window, {
    page: "admin",
    send: r => api("POST", "client-error", r),
    show: m => { pageErrors.push(m); renderProbsBanner(); },
  });

  // ---- Logs ----------------------------------------------------------------------------
  const logQ = { level: "", cat: "", q: "" };
  let logEntries = [];
  async function logs(more) {
    const params = new URLSearchParams(Object.entries(logQ).filter(([, v]) => v));
    if (more && logEntries.length) params.set("before", logEntries[logEntries.length - 1].id);
    const r = await api("GET", "admin/logs?" + params);
    logEntries = more ? logEntries.concat(r.entries) : r.entries;
    const rows = logEntries.map(e => `<tr class="lv-${esc(e.level)}"><td class="mono nowrap">${when(e.at)}</td><td>${chip(e.level === "error" ? "fail" : e.level === "warn" ? "warn" : "info", e.level)}</td><td class="mono">${esc(e.cat)}</td><td>${esc(e.msg)}${e.data ? `<details><summary>Details</summary><pre>${esc(JSON.stringify(e.data, null, 1))}</pre></details>` : ""}</td></tr>`).join("");
    const opt = (list, v) => list.map(([val, lab]) => `<option value="${val}" ${val === v ? "selected" : ""}>${lab}</option>`).join("");
    return `<form class="listbar" id="logForm">
        <select name="level" aria-label="Level">${opt([["", "All levels"], ["warn", "Warnings and errors"], ["error", "Errors"]], logQ.level)}</select>
        <select name="cat" aria-label="Category">${opt([["", "All categories"], ["http", "Requests"], ["auth", "Sign-in"], ["admin", "Administration"], ["security", "Security"], ["pricing", "Prices"], ["backup", "Backups"], ["app", "Server"]], logQ.cat)}</select>
        <label class="search"><input name="q" type="search" value="${esc(logQ.q)}" placeholder="Search" aria-label="Search the log"></label>
        <button class="btn sm" type="submit">Show</button></form>
      <div class="tablewrap"><table class="logtable"><thead><tr><th>Time</th><th>Level</th><th>Category</th><th>Message</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty-state">Nothing logged that matches.</td></tr>`}</tbody></table></div>
      <div class="formfoot pad">${r.entries.length >= 200 ? `<button class="btn sm" type="button" id="moreLogs">Older entries</button>` : `<span class="hint">Recent entries since the server started; older ones are in the daily files.</span>`}
        <span class="links">${r.files.slice(0, 14).map(f => `<a href="api/admin/logs/files/${esc(f.name)}">${esc(f.day)} (${size(f.bytes)})</a>`).join("")}</span></div>`;
  }
  function wireLogs() {
    $("#logForm").onsubmit = e => { e.preventDefault(); Object.assign(logQ, formData(e.target)); show(); };
    const m = $("#moreLogs"); if (m) m.onclick = async () => { main.innerHTML = await logs(true); wireLogs(); };
  }

  // ---- routing -------------------------------------------------------------------------
  const VIEWS = { overview: [overview], people: [people, wirePeople], signin: [signin, wireSignin], tokens: [tokens, wireTokens], sessions: [sessions, wireSessions], guests: [guests, wireGuests], backups: [backups, wireBackups], prices: [prices, wirePrices], security: [security, wireSecurity], problems: [problems, wireProblems], logs: [logs, wireLogs] };
  async function show() {
    const key = (location.hash.slice(1) in VIEWS) ? location.hash.slice(1) : "overview";
    document.querySelectorAll(".admintabs .tab").forEach(t => t.setAttribute("aria-selected", t.getAttribute("href") === "#" + key));
    const [render, wire] = VIEWS[key];
    try { main.innerHTML = await render(); wire?.(); }
    catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
    main.querySelector("[data-refresh]")?.addEventListener("click", show);
  }
  window.addEventListener("hashchange", () => { show(); renderProbsBanner(); });
  fetch("api/auth/me", { credentials: "same-origin" }).then(r => r.json()).then(me => {
    if (!me.user) return location.replace("login.html");
    if (me.user.role !== "admin") return location.replace("./");
    $("#who").textContent = `Signed in as ${me.user.name} (${me.user.username})`;
    show();
    loadProblems();
    setInterval(() => { if (document.visibilityState === "visible") loadProblems(); }, 60_000);
  });
})();
