/*
 * Storage for the ledger page. The page was first built as a claude.ai artifact, which
 * gets its database, photo storage and downloads from `window.claude.use(...)`. This file
 * provides the same three things backed by this app's own server, so the page itself
 * barely changed:
 *
 *   db         collection(name).onSnapshot / .doc(id).set, doc(path).update / .delete / .onSnapshot
 *   assets     upload(blob) -> {id}, delete(id); photos are served at blob/<id>
 *   downloads  save({filename, data}) saves a file in the browser
 *
 * Every URL is relative, so the app works at the site root or under a path like /binder/.
 */
(() => {
  "use strict";

  /** Errors carry a `code` the page already understands (quota_exceeded, invalid_argument…). */
  const fail = (code, message) => Object.assign(new Error(message || code), { code });

  /** Signed out (the session ended or the password changed): go to the sign-in page. */
  function signIn() {
    location.assign("login.html");
  }

  async function call(method, url, body, type) {
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "Content-Type": type || "application/json" },
        body: body === undefined ? undefined : type ? body : JSON.stringify(body),
      });
    } catch (e) {
      throw fail("unavailable", "Couldn't reach the server");
    }
    if (res.status === 401) { signIn(); throw fail("not_granted", "Please sign in"); }
    if (!res.ok) {
      let info = {};
      try { info = await res.json(); } catch (_) {}
      const code = info.code || (res.status === 413 ? "too_large" : res.status === 429 ? "rate_limited" : res.status >= 500 ? "unavailable" : "invalid_argument");
      throw fail(code, info.error || res.statusText);
    }
    return res.status === 204 ? null : res.json();
  }

  // ---- database ------------------------------------------------------------------
  const COLS = ["binders", "cards", "settings"];
  const cache = { binders: new Map(), cards: new Map(), settings: new Map() };
  const watchers = { binders: new Set(), cards: new Set(), settings: new Set() };
  const docWatchers = new Map(); // "settings/main" -> Set

  const colSnap = col => ({ docs: [...cache[col].entries()].map(([id, d]) => ({ id, data: () => ({ ...d }) })) });
  const docSnap = (col, id) => { const d = cache[col].get(id); return { id, exists: !!d, data: () => (d ? { ...d } : undefined) }; };
  /* Each watcher hears every change even if one before it fails; the failure is reported like any page error. */
  function tell(fn, snap) {
    try { fn(snap); }
    catch (e) { if (typeof window.reportError === "function") window.reportError(e); else setTimeout(() => { throw e; }); }
  }
  function notify(col, id) {
    for (const fn of watchers[col]) tell(fn, colSnap(col));
    const set = docWatchers.get(col + "/" + id);
    if (set) for (const fn of set) tell(fn, docSnap(col, id));
  }
  function notifyAll() {
    for (const col of COLS) {
      for (const fn of watchers[col]) tell(fn, colSnap(col));
      for (const [key, set] of docWatchers) if (key.startsWith(col + "/")) for (const fn of set) tell(fn, docSnap(col, key.slice(col.length + 1)));
    }
  }
  function apply(col, id, doc) {
    if (doc) { const { id: _id, ...rest } = doc; cache[col].set(id, rest); } else cache[col].delete(id);
    notify(col, id);
  }

  async function loadAll() {
    const all = await call("GET", "api/data");
    for (const col of COLS) { cache[col].clear(); for (const { id, ...d } of all[col] || []) cache[col].set(id, d); }
    notifyAll();
  }

  /** Live updates from other tabs and devices; on reconnect, reload in case anything was missed. */
  function connect() {
    let es, first = true;
    const open = () => {
      es = new EventSource("api/events");
      es.addEventListener("hello", () => { if (!first) loadAll().catch(() => {}); first = false; setOnline(true); });
      es.onmessage = m => {
        let e; try { e = JSON.parse(m.data); } catch (_) { return; }
        if (e.type === "change") apply(e.change.collection, e.change.id, e.change.doc);
        else if (e.type === "reset") loadAll().catch(() => {});
      };
      es.onerror = () => {
        setOnline(false);
        // A signed-out stream fails for good; check once whether that's why.
        if (es.readyState === EventSource.CLOSED) { fetch("api/data", { method: "HEAD" }).then(r => { if (r.status === 401) signIn(); else setTimeout(open, 3000); }, () => setTimeout(open, 3000)); }
      };
    };
    open();
  }

  let offlineEl = null;
  function setOnline(on) {
    if (on) { offlineEl?.remove(); offlineEl = null; return; }
    if (offlineEl) return;
    offlineEl = document.createElement("div");
    offlineEl.className = "offline";
    offlineEl.setAttribute("role", "status");
    offlineEl.textContent = "Reconnecting… changes you make now may not save.";
    document.body.appendChild(offlineEl);
  }

  const parsePath = p => { const [col, id] = String(p).split("/"); if (!COLS.includes(col) || !id) throw fail("invalid_argument", "Bad path " + p); return [col, id]; };
  const docRef = (col, id) => ({
    id,
    async set(data) { const d = await call("PUT", `api/docs/${col}/${encodeURIComponent(id)}`, data); apply(col, id, d); },
    async update(patch) { const d = await call("PATCH", `api/docs/${col}/${encodeURIComponent(id)}`, patch); apply(col, id, d); },
    async delete() { await call("DELETE", `api/docs/${col}/${encodeURIComponent(id)}`); apply(col, id, null); },
    onSnapshot(fn) {
      const key = col + "/" + id; if (!docWatchers.has(key)) docWatchers.set(key, new Set());
      docWatchers.get(key).add(fn); fn(docSnap(col, id));
      return () => docWatchers.get(key)?.delete(fn);
    },
  });
  const db = {
    collection(col) {
      if (!COLS.includes(col)) throw fail("invalid_argument", "Unknown collection " + col);
      return {
        doc: id => docRef(col, id),
        onSnapshot(fn) { watchers[col].add(fn); fn(colSnap(col)); return () => watchers[col].delete(fn); },
      };
    },
    doc: p => docRef(...parsePath(p)),
  };

  // ---- photos --------------------------------------------------------------------
  const assets = {
    async upload(blob) {
      const r = await call("POST", "api/assets", blob, blob.type || "application/octet-stream");
      return { id: r.id };
    },
    async delete(id) { await call("DELETE", "api/assets/" + encodeURIComponent(id)); },
  };

  // ---- downloads -----------------------------------------------------------------
  const downloads = {
    async save({ filename, data, type }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: type || (/\.csv$/i.test(filename) ? "text/csv;charset=utf-8" : "application/octet-stream") });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.style.display = "none";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };

  // ---- backups -------------------------------------------------------------------
  const backup = {
    /** Everything, photos included, as one JSON file. */
    download() { location.assign("api/backup"); },
    async restore(file) {
      const r = await call("POST", "api/restore", await file.text(), "application/json");
      await loadAll();
      return r;
    },
  };

  // The database is ready once the first load succeeds; if the server can't be reached the
  // page shows its "saving isn't available" banner instead of an empty ledger.
  let ready = null;
  function start() {
    return (ready ??= loadAll().then(() => { connect(); return db; }, e => { console.error(e); return null; }));
  }

  window.claude = {
    use(name) {
      if (name === "db") return start();
      if (name === "assets") return start().then(d => (d ? assets : null));
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.resolve(null);
    },
  };
  window.ledgerBackup = backup;
  /** Plain API calls (automatic pricing, sign-out), with the same error handling as the database. */
  window.ledgerApi = { call: (method, url, body) => call(method, url, body) };
})();
