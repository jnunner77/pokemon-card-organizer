/* Keyboard shortcuts on a binder page, as pure functions so they can be tested: which shortcut a key
   press is (Ctrl/⌘+D duplicate, O owner, S status, K or "/" find, Shift+arrows extend a selection),
   which filled pocket an arrow key moves to, and how the modifier key is written for this computer.
   Ctrl+F is left to the browser. A plain script: the page uses window.BinderKeys, and the tests load it
   the same way. */
(function (root) {
  "use strict";

  const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  const MOD = { d: "duplicate", o: "owner", s: "status", k: "find" };

  /* The shortcut a key press stands for: "duplicate", "owner", "status", "find", "extend", or null */
  const shortcut = (e) => {
    if (!e || typeof e.key !== "string" || e.altKey) return null;
    const mod = !!(e.ctrlKey || e.metaKey), k = e.key.toLowerCase();
    if (mod) return !e.shiftKey && Object.prototype.hasOwnProperty.call(MOD, k) ? MOD[k] : null;
    if (e.key === "/") return "find";
    if (e.shiftKey && ARROWS.includes(e.key)) return "extend";
    return null;
  };

  /* The filled pocket an arrow key moves to from pocket `from` (null: none yet), or null when there is
     none. filled: the page's filled pocket numbers, ascending; cols: pockets per row. Up and Down go to
     the filled pocket nearest in column in the next row that has one (the left one on a tie) */
  const step = (filled, cols, from, key) => {
    if (!filled.length) return null;
    if (from == null) return key === "ArrowRight" || key === "ArrowDown" ? filled[0] : key === "ArrowLeft" || key === "ArrowUp" ? filled[filled.length - 1] : null;
    let hit;
    if (key === "ArrowRight") hit = filled.find((s) => s > from);
    else if (key === "ArrowLeft") hit = filled.slice().reverse().find((s) => s < from);
    else if (key === "ArrowDown" || key === "ArrowUp") {
      const row = (s) => Math.floor((s - 1) / cols), col = (s) => (s - 1) % cols, dir = key === "ArrowDown" ? 1 : -1;
      const rows = filled.map(row).filter((r) => (r - row(from)) * dir > 0);
      if (rows.length) {
        const r = dir > 0 ? Math.min(...rows) : Math.max(...rows);
        hit = filled.filter((s) => row(s) === r).reduce((best, s) => (best == null || Math.abs(col(s) - col(from)) < Math.abs(col(best) - col(from)) ? s : best), null);
      }
    }
    return hit == null ? null : hit;
  };

  /* The filled pockets from a to b, whichever comes first */
  const range = (filled, a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return filled.filter((s) => s >= lo && s <= hi);
  };

  /* How the modifier key is written: "⌘" on Apple devices, else "Ctrl+" */
  const modLabel = (platform) => (/Mac|iPhone|iPad|iPod/.test(String(platform || "")) ? "⌘" : "Ctrl+");

  /* Whether a shortcut may act now. ctx: lightbox, modal (a dialog is open), typing (focus is in a
     field), table, pricing, selling (those views are open). Find works in the views; the rest don't */
  const allowed = (k, ctx) => !!k && !ctx.lightbox && !ctx.modal && !ctx.typing && (k === "find" || !(ctx.table || ctx.pricing || ctx.selling));

  /* The cards a duplicate, owner or status shortcut is for: the selected cards, else the open saved
     card. picked: ids of the selected cards; open: the open card's id, or null when none (or a new
     draft). Returns { ids, picking } or null */
  const target = (picked, open) => (picked && picked.length ? { ids: picked.slice(), picking: true } : open ? { ids: [open], picking: false } : null);

  /* Whether Shift+arrows may select on this view. st: view, hasBinder, isCase, special, swap, mode */
  const canExtend = (st) => st.view === "pages" && !!st.hasBinder && !st.isCase && !st.special && !st.swap && st.mode === "ready";

  /* One Shift+arrow press. st: key, filled, cols, bid, page, kb ({bid,page,anchor,cur} or null),
     picking (a selection is under way), focused (slot of the focused pocket or null), open (slot of the
     open card on this page or null). Returns null when nothing can be selected, else { kb, start,
     slots }: the new range, whether a selection must be started first, and the pockets it covers */
  const extend = (st) => {
    if (!st.filled.length) return null;
    let kb, start = false;
    if (st.kb && st.picking && st.kb.bid === st.bid && st.kb.page === st.page) {
      const next = step(st.filled, st.cols, st.kb.cur, st.key);
      kb = { bid: st.bid, page: st.page, anchor: st.kb.anchor, cur: next == null ? st.kb.cur : next };
    } else {
      const anchor = st.focused != null ? st.focused : st.open != null ? st.open : step(st.filled, st.cols, null, st.key);
      if (anchor == null) return null;
      kb = { bid: st.bid, page: st.page, anchor, cur: anchor };
      start = !st.picking;
    }
    return { kb, start, slots: range(st.filled, kb.anchor, kb.cur) };
  };

  root.BinderKeys = { shortcut, step, range, modLabel, allowed, target, canExtend, extend };
})(typeof window !== "undefined" ? window : globalThis);
