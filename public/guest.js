// Guest page: people who scan the QR code sign in with their name and a phone number or email,
// then look through the cards listed for sale: search, sort, and flip through them full screen.
// The server decides what guests see (server/guests.ts); this page only shows it.
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = sessionStorage.getItem("guest." + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { sessionStorage.setItem("guest." + k, JSON.stringify(v)); } catch (_) {} },
  };
  const dollars = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0, minimumFractionDigits: 0 });
  const money = n => n == null ? "" : dollars.format(n);
  let toastT;
  const toast = msg => { const r = $("toastRoot"); r.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`; clearTimeout(toastT); toastT = setTimeout(() => r.innerHTML = "", 3200); };

  // The QR code's key: kept for this tab (to sign in again after a time-out) and taken out of the
  // address bar, so a copied or shared link doesn't carry it.
  const url = new URL(location.href);
  if (url.searchParams.has("k")) {
    store.set("key", url.searchParams.get("k"));
    url.searchParams.delete("k");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
  const key = () => store.get("key", "");

  const G = { me: null, cards: [], q: "", sort: "value-desc", lastUse: Date.now(), lastCheck: Date.now(), timer: 0, live: null };
  try { G.sort = localStorage.getItem("guest.sort") || G.sort; } catch (_) {}

  class Ended extends Error {}
  async function api(method, path, body) {
    const r = await fetch("api/guest/" + path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Ended(data.error || "Your visit ended.");
    if (!r.ok) throw Object.assign(new Error(data.error || "That didn't work. Try again."), { code: data.code });
    return data;
  }

  // ---- screens ---------------------------------------------------------------------------
  function screen(name, text) {
    $("gLoading").hidden = true;
    $("gStart").hidden = name === "main";
    $("gSignin").hidden = name !== "signin";
    $("gClosed").hidden = name !== "closed";
    $("gMain").hidden = name !== "main";
    if (name === "closed") $("gClosedText").textContent = text;
    if (name === "signin") {
      $("gLead").textContent = text || "Look through every card we have for sale. Tell us who you are to start.";
      const who = store.get("who", {});
      if (!$("gName").value) $("gName").value = who.name || "";
      if (!$("gContact").value) $("gContact").value = who.contact || "";
      ($("gName").value ? $("gSignin").querySelector("button") : $("gName")).focus();
    }
  }
  const msg = text => { $("gSignin").querySelector(".msg").textContent = text || ""; };

  async function boot() {
    let me;
    try { me = await api("GET", "me" + (key() ? "?k=" + encodeURIComponent(key()) : "")); }
    catch (_) { return screen("closed", "Couldn't reach the binder. Check your connection and reload the page."); }
    document.querySelectorAll("[data-idle]").forEach(e => e.textContent = me.idleMinutes);
    if (me.guest) return start(me.guest);
    pickScreen(me);
  }
  function pickScreen(me, endedText) {
    if (!me.open) return screen("closed", "Guest viewing is closed right now. Ask at the table.");
    if (!key() || me.keyOk === false) return screen("closed", "This QR code no longer works. Scan the one at the table to look through the cards.");
    screen("signin", endedText);
  }

  async function start(guest) {
    G.me = guest;
    $("gWho").textContent = `Signed in as ${guest.name}`;
    $("gSort").value = G.sort;
    screen("main");
    await loadCards();
    listen();
    G.lastUse = G.lastCheck = Date.now();
    clearInterval(G.timer);
    G.timer = setInterval(check, 30_000);
  }

  async function ended(text) {
    clearInterval(G.timer);
    unlisten();
    closeViewer();
    G.me = null; G.cards = [];
    $("gGrid").innerHTML = "";
    let me = { open: true, keyOk: null };
    try { me = await api("GET", "me" + (key() ? "?k=" + encodeURIComponent(key()) : "")); } catch (_) {}
    pickScreen(me, text);
  }
  const timedOut = () => ended("You were signed out after a while without use. Sign in again to keep looking.");

  $("gSignin").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const name = $("gName").value.trim(), contact = $("gContact").value.trim();
    if (!name) return msg("Enter your name."), $("gName").focus();
    if (!contact) return msg("Enter your phone number or email."), $("gContact").focus();
    btn.disabled = true; msg("");
    try {
      const r = await api("POST", "login", { key: key(), name, contact });
      store.set("who", { name, contact });
      await start(r.guest);
    } catch (err) {
      if (err.code === "guests_closed" || err.code === "guest_key") return pickScreen({ open: err.code !== "guests_closed", keyOk: false });
      msg(err.message || "Couldn't reach the binder. Check your connection.");
    } finally { btn.disabled = false; }
  });

  $("gSignout").addEventListener("click", async () => {
    try { await api("POST", "logout"); } catch (_) {}
    clearInterval(G.timer);
    unlisten();
    closeViewer();
    G.me = null; G.cards = []; $("gGrid").innerHTML = "";
    screen("signin", "You're signed out. Thanks for looking!");
  });

  // ---- staying signed in -----------------------------------------------------------------
  // The server signs a guest out after 15 minutes without use. Tapping, scrolling and typing here
  // count as use; the page tells the server so twice a minute, and otherwise only asks whether the
  // visit is still on (which doesn't count).
  const used = () => { G.lastUse = Date.now(); };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchmove"]) window.addEventListener(ev, used, { passive: true, capture: true });
  window.addEventListener("scroll", used, { passive: true, capture: true });
  async function check() {
    if (!G.me) return;
    const active = G.lastUse > G.lastCheck;
    G.lastCheck = Date.now();
    try {
      if (active) await api("POST", "ping");
      else { const me = await api("GET", "me"); if (!me.guest) return timedOut(); }
      listen(); // live updates dropped (too many open, say): try again
    } catch (err) { if (err instanceof Ended) timedOut(); }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !G.me) return;
    // Back on the page: still signed in? Then catch up on cards sold or listed meanwhile.
    api("GET", "me").then(me => me.guest ? (loadCards(), listen()) : timedOut(), () => {});
  });

  // ---- live updates ----------------------------------------------------------------------
  // The server sends the cards guests see on connecting and whenever that changes (a card listed,
  // delisted, sold or repriced). The browser reconnects by itself after a dropped connection; once
  // the server turns it away (the visit ended, too many open), it stays closed and check() retries.
  function listen() {
    if (!G.me || !window.EventSource || (G.live && G.live.readyState !== EventSource.CLOSED)) return;
    const es = G.live = new EventSource("api/guest/events");
    es.addEventListener("cards", e => { if (G.live === es) try { showCards(JSON.parse(e.data)); } catch (_) {} });
    es.addEventListener("error", () => {
      if (es.readyState !== EventSource.CLOSED || G.live !== es) return;
      G.live = null;
      api("GET", "me").then(me => { if (!me.guest && G.me) timedOut(); }, () => {});
    });
  }
  function unlisten() {
    if (G.live) G.live.close();
    G.live = null;
  }

  // ---- the cards -------------------------------------------------------------------------
  async function loadCards() {
    try { showCards((await api("GET", "cards")).cards, true); }
    catch (err) { if (err instanceof Ended) return timedOut(); toast(err.message); render(); }
  }
  /* always: draw it even if nothing changed */
  function showCards(cards, always) {
    if (!G.me || (!always && JSON.stringify(cards) === JSON.stringify(G.cards))) return;
    G.cards = cards;
    render();
    // Full screen stays on the card it showed; one that's no longer for sale drops out.
    if (!LB.open) return;
    const list = G.list || [];
    if (!list.length) return closeViewer();
    if (JSON.stringify(list) === JSON.stringify(LB.list)) return;
    const at = list.findIndex(c => c.id === LB.list[LB.i]?.id);
    openViewer(at >= 0 ? at : Math.min(LB.i, list.length - 1), true);
  }

  const year = c => (c.released || "").slice(0, 4);
  const code = c => [c.setCode || c.set, c.number].filter(Boolean).join(" ");
  const shape = c => c.grader && c.grader !== "Raw" ? [c.grader, c.grade].filter(Boolean).join(" ") : c.condition;
  const SORTS = {
    "value-desc": (a, b) => (b.value ?? -1) - (a.value ?? -1),
    "value-asc": (a, b) => (a.value ?? Infinity) - (b.value ?? Infinity),
    name: () => 0,
    new: (a, b) => (b.released || "").localeCompare(a.released || ""),
    old: (a, b) => (a.released || "9999").localeCompare(b.released || "9999"),
  };
  function shownList() {
    if (G.q.trim()) return window.BinderSearch.search(G.cards, G.q, { limit: G.cards.length }).map(r => r.card);
    const by = SORTS[G.sort] || SORTS["value-desc"];
    return G.cards.slice().sort((a, b) => by(a, b) || String(a.name || "").localeCompare(String(b.name || "")));
  }
  function render() {
    const list = shownList();
    G.list = list;
    const n = G.cards.length;
    $("gCount").textContent = G.q.trim()
      ? `${list.length} of ${n} card${n === 1 ? "" : "s"} match`
      : `${n} card${n === 1 ? "" : "s"} for sale · tap a card to see it full screen`;
    $("gGrid").innerHTML = list.length ? list.map((c, i) => `<button type="button" class="gcard" data-gi="${i}">
        <span class="pic">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" draggable="false">` : `<span class="face">No picture yet</span>`}</span>
        <span class="n">${esc(c.name || "Unnamed card")}</span>
        <span class="m">${esc([code(c), c.rarity].filter(Boolean).join(" · "))}</span>
        <span class="row"><span class="m">${esc(shape(c) || "")}</span><span class="v">${esc(money(c.value))}</span></span>
      </button>`).join("")
      : `<p class="empty-state">${n ? "No cards match. Try a Pokémon name, a set or a card number." : "Nothing is listed for sale right now. Check back soon!"}</p>`;
  }
  $("gQuery").addEventListener("input", e => { G.q = e.target.value; render(); });
  $("gSort").addEventListener("change", e => {
    G.sort = e.target.value;
    try { localStorage.setItem("guest.sort", G.sort); } catch (_) {}
    if (G.q) { G.q = ""; $("gQuery").value = ""; }
    render();
  });
  $("gGrid").addEventListener("click", e => {
    const b = e.target.closest("[data-gi]");
    if (b) openViewer(+b.dataset.gi);
  });
  document.addEventListener("keydown", e => {
    if (LB.open) return;
    if (e.key === "/" && G.me && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); $("gQuery").focus(); }
  });

  // ---- full screen -----------------------------------------------------------------------
  const LB = { open: false, list: [], i: 0, last: -1, raf: 0, back: null };
  const back = window.BackClose.create(history, () => closeViewer(true));
  window.addEventListener("popstate", e => back.popstate(e.state));
  const track = () => $("lbTrack");
  function caption(c) {
    const lines = [
      [code(c), c.rarity].filter(Boolean).join(" · "),
      [c.setCode && c.set, year(c)].filter(Boolean).join(" · "),
      [shape(c), c.variant, c.language].filter(Boolean).join(" · "),
      c.artist ? `Illustrated by ${c.artist}` : "",
    ].filter(Boolean);
    return `<span class="n">${esc(c.name || "Unnamed card")}</span>${lines.map(l => `<span class="m">${esc(l)}</span>`).join("")}${c.value != null ? `<span class="v">${esc(money(c.value))}</span>` : ""}`;
  }
  /* again: redraw the open viewer with the latest list */
  function openViewer(i, again) {
    const list = G.list || [];
    if (!list.length) return;
    Object.assign(LB, { open: true, list, i, last: -1, back: again ? LB.back : document.activeElement });
    const n = list.length;
    const slides = list.map((c, k) => `<div class="lb-slide" role="group" aria-roledescription="slide" aria-label="${k + 1} of ${n}: ${esc(c.name || "Unnamed card")}">${c.image ? `<img data-src="${esc(c.image)}" alt="${esc(c.name || "Card")}" draggable="false">` : `<span class="lb-noimg">No picture yet</span>`}</div>`).join("");
    const thumbs = n > 1 ? `<div class="lb-strip" id="lbStrip">${list.map((c, k) => `<button type="button" class="lb-th" data-lbi="${k}" aria-label="Card ${k + 1}: ${esc(c.name || "Unnamed card")}">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" draggable="false">` : ""}</button>`).join("")}</div>` : "";
    $("lbRoot").innerHTML = `<div class="lb${again ? " again" : ""}" role="dialog" aria-modal="true" aria-label="Cards full screen">
      <div class="lb-top"><span class="lb-count" id="lbCount" aria-live="polite"></span>
        <div class="lb-acts"><button type="button" class="lb-btn" data-lb="close" aria-label="Close full screen">✕ Close</button></div></div>
      <div class="lb-stage">
        <div class="lb-track" id="lbTrack" tabindex="-1">${slides}</div>
        ${n > 1 ? `<button type="button" class="lb-nav prev" data-lb="prev" aria-label="Previous card">‹</button><button type="button" class="lb-nav next" data-lb="next" aria-label="Next card">›</button>` : ""}
      </div>
      <div class="lb-cap" id="lbCap"></div>
      ${thumbs}</div>`;
    document.documentElement.style.overflow = "hidden";
    back.sync(true);
    const tr = track();
    tr.addEventListener("scroll", () => { cancelAnimationFrame(LB.raf); LB.raf = requestAnimationFrame(sync); }, { passive: true });
    load(i);
    requestAnimationFrame(() => { tr.style.scrollBehavior = "auto"; tr.scrollLeft = i * tr.clientWidth; sync(true); });
    $("lbRoot").querySelector('[data-lb="close"]').focus({ preventScroll: true });
  }
  function load(i) {
    document.querySelectorAll("#lbTrack .lb-slide").forEach((s, k) => { const im = s.querySelector("img"); if (im && Math.abs(k - i) <= 2 && !im.getAttribute("src")) im.src = im.dataset.src; });
  }
  function sync(force) {
    const tr = track(); if (!tr || !LB.open) return;
    const n = LB.list.length, i = Math.min(n - 1, Math.max(0, Math.round(tr.scrollLeft / Math.max(1, tr.clientWidth))));
    if (i === LB.last && force !== true) return;
    LB.i = i; LB.last = i; load(i);
    $("lbCount").textContent = `${i + 1} / ${n}`;
    $("lbCap").innerHTML = caption(LB.list[i]);
    const pv = $("lbRoot").querySelector('[data-lb="prev"]'), nx = $("lbRoot").querySelector('[data-lb="next"]');
    if (pv) pv.disabled = i <= 0;
    if (nx) nx.disabled = i >= n - 1;
    const strip = $("lbStrip");
    if (strip) {
      strip.querySelectorAll(".lb-th").forEach((b, k) => b.setAttribute("aria-current", k === i));
      const th = strip.children[i];
      if (th) strip.scrollTo({ left: Math.max(0, th.offsetLeft - (strip.clientWidth - th.offsetWidth) / 2), behavior: force === true ? "auto" : "smooth" });
    }
  }
  function go(k) {
    const tr = track(); if (!tr) return;
    k = Math.min(LB.list.length - 1, Math.max(0, k)); load(k);
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    tr.scrollTo({ left: k * tr.clientWidth, behavior: reduce ? "auto" : "smooth" });
  }
  /* fromBack: the phone's Back closed it, so its history entry is gone already */
  function closeViewer(fromBack) {
    if (!LB.open) return;
    LB.open = false;
    $("lbRoot").innerHTML = "";
    document.documentElement.style.overflow = "";
    if (fromBack !== true) back.sync(false);
    const i = LB.i, b = LB.back; LB.list = [];
    // Leave the grid at the card the guest stopped on.
    const tile = document.querySelector(`[data-gi="${i}"]`);
    if (tile) { tile.scrollIntoView({ block: "nearest" }); try { tile.focus({ preventScroll: true }); } catch (_) {} }
    else if (b && document.contains(b)) try { b.focus({ preventScroll: true }); } catch (_) {}
  }
  $("lbRoot").addEventListener("click", e => {
    const a = e.target.closest("[data-lb]");
    if (a) {
      const k = a.dataset.lb;
      if (k === "close") return closeViewer();
      if (k === "prev") return go(LB.i - 1);
      if (k === "next") return go(LB.i + 1);
    }
    const th = e.target.closest("[data-lbi]");
    if (th) go(+th.dataset.lbi);
  });
  $("lbRoot").addEventListener("contextmenu", e => { if (e.target.closest(".lb-slide img")) e.preventDefault(); });
  document.addEventListener("keydown", e => {
    if (!LB.open) return;
    if (e.key === "Escape") { e.preventDefault(); closeViewer(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); go(LB.i + (e.key === "ArrowLeft" ? -1 : 1)); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); go(e.key === "Home" ? 0 : LB.list.length - 1); }
  });
  window.addEventListener("resize", () => { if (!LB.open) return; const tr = track(); if (tr) { tr.style.scrollBehavior = "auto"; tr.scrollLeft = LB.i * tr.clientWidth; } });

  boot();
})();
