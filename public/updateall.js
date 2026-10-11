/* Settings → Update all cards: what each choice does, which cards a picture update visits (the
   same rule as the server, PriceUpdater.needsPicture), and what's running now.
   A plain script: the page uses window.BinderUpdateAll, and the tests load it the same way. */
(function (root) {
  "use strict";

  /* The choices, in order: `scope` is what POST api/pricing/run updates (Details has its own call). */
  const KINDS = [
    { k: "all", label: "Everything", scope: "all", hint: "Looks every card up again in the card database, then logs today's price and downloads its picture." },
    { k: "prices", label: "Prices", scope: "prices", hint: "Logs today's price for every card, nothing else." },
    { k: "pictures", label: "Pictures", scope: "pictures", hint: "Downloads a picture for each card without an official one, or with the card database's smaller one. Logs no prices." },
    { k: "details", label: "Details", scope: null, hint: "Looks up every card with a blank set, set code, rarity, illustrator or release date again." },
  ];

  const gone = c => c.status === "sold" || c.status === "traded";

  /* A card a picture update visits: still owned, priced automatically, and without an official
     picture or with TCGdex's smaller one (TCGplayer's product picture replaces it). */
  function needsPicture(c) {
    if (!c || gone(c) || (c.pricing && c.pricing.source === "off")) return false;
    return !c.officialImageId || /tcgdex/i.test((c.pricing && c.pricing.imageUrl) || "");
  }

  const NAMES = { all: "Updating everything", prices: "Updating prices", pictures: "Updating pictures" };

  /* What's running now, in words: "Updating pictures: 3 of 12 cards (now Snorlax LOR TG10)". */
  function progress(pricing, details) {
    const out = [];
    const p = pricing || {}, d = details || {};
    if (p.running) out.push(`${NAMES[p.scope] || NAMES.all}: ${p.done || 0} of ${p.total || 0} cards${p.current && p.current.card ? ` (now ${p.current.card})` : ""}`);
    if (d.running) out.push(`Looking up details: ${d.done || 0} of ${d.total || 0} cards`);
    return out;
  }

  /* The last picture update, in words. */
  function lastPictures(pricing) {
    const r = pricing && pricing.lastPictureRun;
    if (!r) return "";
    const c = r.counts || {};
    const ended = r.ended === "stopped" ? " (stopped)" : r.ended === "failed" ? " (failed)" : "";
    return `Last picture update ${r.date}${ended}: ${c.updated || 0} pictured${c.noPicture ? ` · ${c.noPicture} still without a picture` : ""}${c.failed ? ` · ${c.failed} failed` : ""}`;
  }

  root.BinderUpdateAll = { KINDS, needsPicture, progress, lastPictures };
})(typeof window !== "undefined" ? window : globalThis);
