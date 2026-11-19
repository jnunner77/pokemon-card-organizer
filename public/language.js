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

  /* The catalog a looked-up card's id is from (the server's JAPANESE_MATCH). */
  const ofId = id => (/^ja-(\d{1,9})-(\d{1,12})$/.test(String(id == null ? "" : id)) ? "ja" : "en");

  /* The language to give a card made from a looked-up card, by its id. */
  const label = id => (ofId(id) === "ja" ? "Japanese" : "English");

  /* Whether a card's recorded match (card.details.id) is from the other catalog than its language uses (an English
     card set to Japanese afterwards, or the reverse): the server looks it up again, complete or not.
     Mirrors matchedOtherCatalog in src/domain/catalog/japanese.ts. */
  function matchedOtherCatalog(card) {
    const d = card && card.details;
    const id = d && typeof d === "object" && !Array.isArray(d) && typeof d.id === "string" ? d.id : "";
    const language = catalogLanguage(card && card.language);
    return !!id && language !== null && ofId(id) !== language;
  }

  root.BinderLanguage = { catalogLanguage, looksUp, param, ofId, label, matchedOtherCatalog };
})(typeof window !== "undefined" ? window : globalThis);
