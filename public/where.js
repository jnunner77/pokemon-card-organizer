/* Where a price came from, a card sold or was bought (eBay, Card show…): a dropdown of the usual
   places that opens with one tap, and Custom… for any other place, typed in a field it shows.
   A plain script: the page uses window.BinderWhere, and the tests load it the same way. */
(function (root) {
  "use strict";

  const CUSTOM = "__custom";

  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  /* The dropdown (id) and its Custom… field (id + "_custom"). value: what's saved now; a place not
     in the list opens as Custom… with that text, and "" as "—" (no place). */
  function html(id, places, value, placeholder) {
    const v = String(value ?? "").trim();
    const custom = v !== "" && !places.includes(v);
    const opts = [`<option value=""${v === "" ? " selected" : ""}>—</option>`]
      .concat(places.map(p => `<option value="${esc(p)}"${p === v ? " selected" : ""}>${esc(p)}</option>`))
      .concat(`<option value="${CUSTOM}"${custom ? " selected" : ""}>Custom…</option>`);
    return `<span class="wherepick"><select id="${esc(id)}" data-where>${opts.join("")}</select>`
      + `<input id="${esc(id)}_custom" class="wherecustom" value="${custom ? esc(v) : ""}" placeholder="${esc(placeholder || "Type where")}" aria-label="Custom place" maxlength="80" autocomplete="off" autocapitalize="words"${custom ? "" : " hidden"}></span>`;
  }

  /* What to save: the chosen place, or the typed one when Custom… is chosen. */
  function read(select, custom) {
    if (!select) return "";
    return (select.value === CUSTOM ? (custom ? custom.value : "") : select.value).trim();
  }

  /* After the dropdown changes: show the Custom… field (and put the cursor in it) or hide it. */
  function toggle(select, doc) {
    if (!select || !select.matches || !select.matches("select[data-where]")) return;
    const custom = (doc || root.document).getElementById(select.id + "_custom");
    if (!custom) return;
    custom.hidden = select.value !== CUSTOM;
    if (!custom.hidden) custom.focus();
  }

  root.BinderWhere = { html, read, toggle, CUSTOM };
})(typeof window !== "undefined" ? window : globalThis);
