/* Google searches for what a card is missing: its picture (Google Images), its price, or the
   details the card databases left blank (set, set code, rarity, illustrator). Each search names
   the card as the binder has it: name, set, number, variant, a language other than English, and
   the grade of a graded card, so the first results are this printing.
   A plain script: the page uses window.BinderGoogle, and the tests load it the same way. */
(function (root) {
  "use strict";

  const GOOGLE = "https://www.google.com/search";
  /* The details a search can fill, in the words the drawer uses. The release date isn't one: it
     comes from the card database and can't be typed. */
  const DETAILS = [["set", "set"], ["setCode", "set code"], ["rarity", "rarity"], ["artist", "illustrator"]];
  const text = v => String(v ?? "").trim();
  const blank = v => !text(v);
  const PLAIN_VARIANT = /^(normal|regular|non[- ]?holo|unlimited|standard)$/i;

  /* The card in words: "Snorlax Lost Origin Trainer Gallery TG10/TG30 pokemon card". */
  function cardWords(c) {
    const variant = text(c.variant), language = text(c.language);
    const graded = text(c.grader) && text(c.grader) !== "Raw" && text(c.grade) ? `${text(c.grader)} ${text(c.grade)}` : "";
    return [text(c.name), text(c.set) || text(c.setCode), text(c.number), PLAIN_VARIANT.test(variant) ? "" : variant, language && language !== "English" ? language : "", graded, "pokemon card"]
      .filter(Boolean).join(" ").replace(/\s+/g, " ");
  }

  const url = (q, images) => `${GOOGLE}?${images ? "tbm=isch&" : ""}q=${encodeURIComponent(q)}`;

  /* Google Images for the card's picture. */
  const imagesUrl = c => url(cardWords(c), true);
  /* Google for the card's price. */
  const priceUrl = c => url(`${cardWords(c)} price`, false);
  /* Google for the details it's missing (all of them when none are named). */
  function detailsUrl(c, missing) {
    const words = (missing && missing.length ? missing : DETAILS.map(d => d[1]));
    return url(`${cardWords(c)} ${words.join(" ")}`, false);
  }

  const hasPrice = c => (Array.isArray(c.prices) ? c.prices : []).some(p => p && (p.type === "comp" || p.type === "market") && typeof p.amount === "number");

  /* What the card is missing: no picture at all (official or the person's), no price (for a card
     still owned), and which details are blank, in words. */
  function missing(c) {
    const owned = c.status !== "sold" && c.status !== "traded";
    return {
      picture: !c.officialImageId && !c.imageId,
      price: owned && !hasPrice(c),
      details: DETAILS.filter(([k]) => blank(c[k])).map(d => d[1]),
    };
  }

  root.BinderGoogle = { cardWords, imagesUrl, priceUrl, detailsUrl, missing };
})(typeof window !== "undefined" ? window : globalThis);
