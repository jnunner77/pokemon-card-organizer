/* Which card catalog a card is looked up in: TCGdex's English one, or TCGplayer's Japanese one (src/domain/catalog/japanese.ts).
   A card's language says which ("" or English: English, Japanese: Japanese, any other: none), and a looked-up card's id
   says which catalog it came from (Japanese ids look like ja-<set>-<product>).
   A plain script: the page uses window.BinderLanguage, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* "", "English", "en" → "en"; "Japanese", "JP", "ja" → "ja"; anything else → null (no catalog) */
  function catalogLanguage(lang) {
    const s = String(lang == null ? "" : lang).trim();
    if (!s || /^en/i.test(s)) return "en";
    if (/^(ja|jp|japanese)/i.test(s)) return "ja";
    return null;
  }

  /* Whether a card in this language is looked up at all. */
  const looksUp = lang => catalogLanguage(lang) !== null;

  /* The lang= the server is asked with: "ja" or "en". */
  const param = lang => (catalogLanguage(lang) === "ja" ? "ja" : "en");

  /* The catalog a looked-up card's id is from. */
  const ofId = id => (/^ja-\d+-\d+$/.test(String(id == null ? "" : id)) ? "ja" : "en");

  /* The language to give a card made from a looked-up card, by its id. */
  const label = id => (ofId(id) === "ja" ? "Japanese" : "English");

  root.BinderLanguage = { catalogLanguage, looksUp, param, ofId, label };
})(typeof window !== "undefined" ? window : globalThis);
