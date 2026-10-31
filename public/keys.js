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
     none. filled: the page's filled pocket numbers, ascending; cols: pockets per row */
  const step = (filled, cols, from, key) => {
    if (!filled.length) return null;
    if (from == null) return key === "ArrowRight" || key === "ArrowDown" ? filled[0] : key === "ArrowLeft" || key === "ArrowUp" ? filled[filled.length - 1] : null;
    let hit;
    if (key === "ArrowRight") hit = filled.find((s) => s > from);
    else if (key === "ArrowLeft") hit = filled.slice().reverse().find((s) => s < from);
    else if (key === "ArrowDown") hit = filled.find((s) => s >= from + cols);
    else if (key === "ArrowUp") hit = filled.slice().reverse().find((s) => s <= from - cols);
    return hit == null ? null : hit;
  };

  /* The filled pockets from a to b, whichever comes first */
  const range = (filled, a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return filled.filter((s) => s >= lo && s <= hi);
  };

  /* How the modifier key is written: "⌘" on Apple devices, else "Ctrl+" */
  const modLabel = (platform) => (/Mac|iPhone|iPad|iPod/.test(String(platform || "")) ? "⌘" : "Ctrl+");

  root.BinderKeys = { shortcut, step, range, modLabel };
})(typeof window !== "undefined" ? window : globalThis);
