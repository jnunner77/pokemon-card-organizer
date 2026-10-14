// Look up any card, in the ledger or not (Find a card → Any card): search the TCGdex card database
// by name, set and number, then see one card's picture and today's prices, worked out the way the
// daily update would price it (updater.ts). Nothing is saved: the ledger isn't touched.

import { blend } from './blend';
import { type CardDetails, asPrinted, isoDate, mapRarity } from './details';
import { type TcgdexCard, type TcgdexVariant, featuresOf, tcgdexCardmarket, tcgdexTcgplayer, variantLabel, variantPrices } from './pricing/catalog';
import { cardNumber, catalogMismatch, chooseMatch, norm, searchQuery } from './pricing/match';
import type { PcProduct } from './pricing/pricecharting';
import { tcgImage } from './pricing/sources';
import type { PriceUpdater } from './pricing/updater';

/** One card found by a search. */
export interface LookupHit {
  /** TCGdex card id, e.g. "base1-4". */
  id: string;
  name: string;
  /** The number on the card, as TCGdex writes it ("004"). */
  number: string;
  /** How many cards the set officially has (the "/102"); null when TCGdex doesn't say. */
  total: number | null;
  set: string;
  thumb: string | null;
}

/** One printing of a looked-up card (regular, reverse holo, a Poké Ball pattern, 1st Edition…) and its prices. */
export interface LookupPrinting {
  /** In words: "Master Ball reverse", "regular". */
  label: string;
  /** What to type in a card's Variant for this printing ("" for the regular card). */
  variant: string;
  tcgplayer: { usd: number; url: string | null } | null;
  cardmarket: { eur: number } | null;
  pricecharting: { id: string; url: string; title: string; usd: number | null; grades: { label: string; usd: number; cad: number }[] } | null;
  /** TCGplayer's and Cardmarket's prices are for another set or printing than PriceCharting's product: why. */
  leftOut: string | null;
  /** What the daily update would log for it today. */
  price: { usd: number; cad: number; where: string; summary: string } | null;
}

export interface LookupCard {
  id: string;
  name: string;
  number: string;
  total: number | null;
  set: string;
  setCode: string | null;
  rarity: string | null;
  artist: string | null;
  released: string | null;
  image: string | null;
  thumb: string | null;
  printings: LookupPrinting[];
  /** CAD per US dollar and per euro. */
  rates: { usd: number; eur: number | null };
  /** What couldn't be had: a source that didn't answer, or has no match. */
  notes: string[];
}

interface SetBrief {
  id: string;
  name: string;
  cardCount?: { official?: number };
}
interface Brief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}
interface FullCard extends TcgdexCard {
  rarity?: string;
  illustrator?: string;
}
interface SetInfo {
  abbreviation?: { official?: string };
  tcgOnline?: string;
  releaseDate?: string;
}

/** Most results a search returns. */
export const MAX_HITS = 48;
/** Most searches by runs of two or more words one query makes; each word on its own is tried too (each a TCGdex request, remembered for an hour). */
const MAX_TRIES = 6;
/** Words that say which printing, not which card: left out of the search ("pikachu base set holo"); the card view lists every printing. */
/** Words that name no card or set ("pokemon card"): left out when other words come with them. */
const FILLER_WORDS = new Set(['pokemon', 'card', 'cards', 'tcg']);
const PRINTING_WORDS = new Set(['holo', 'holofoil', 'foil', 'reverse', 'rev', 'rh', 'non', 'nonholo', 'normal', 'regular', 'unlimited', '1st', 'first', 'edition', 'ed', 'shadowless', 'stamp', 'stamped', 'pattern']);
const round2 = (n: number) => Math.round(n * 100) / 100;
/** A card number as typed: "4", "4/102", "SWSH050", "TG10", "GG01/GG70". */
const NUMBER = /^[a-z]{0,6}\d+[a-z]?(?:\/[a-z]{0,6}\d+)?$/i;
/** A set card id's set: "sv03.5-006" → "sv03.5". */
const setOf = (c: Brief) => (c.id.endsWith(`-${c.localId}`) ? c.id.slice(0, -c.localId.length - 1) : c.id.replace(/-[^-]+$/, ''));
const wordsOf = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** What to type in a card's Variant for a TCGdex variant: "Master Ball", "1st Edition Holo", "Reverse Holo", "". */
export function variantText(v: TcgdexVariant): string {
  const label = variantLabel(v);
  const features = featuresOf(v).length ? label.replace(/ (?:normal|regular|holo|reverse)$/, '') : '';
  const kind = v.type === 'reverse' ? 'Reverse Holo' : v.type === 'holo' ? 'Holo' : '';
  // A pattern names its printing on its own (a Poké Ball card is a reverse holo).
  return (v.foil ? features : [features, kind].filter(Boolean).join(' ')).trim();
}

export interface CardLookupOptions {
  details: CardDetails;
  updater?: PriceUpdater;
}

export class CardLookup {
  private readonly details: CardDetails;
  private readonly updater?: PriceUpdater;

  constructor(o: CardLookupOptions) {
    this.details = o.details;
    this.updater = o.updater;
  }

  /**
   * Cards matching a query, best first: the longest run of its words that names cards ("charizard
   * ex"), narrowed by the rest, each of which has to be in the card's set name or name, or be its
   * number ("base set 4", "4/102"). A query of only a number finds every card with that number.
   */
  async search(query: string): Promise<{ hits: LookupHit[]; more: boolean }> {
    const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!tokens.length) return { hits: [], more: false };
    const numbers = tokens.filter((t) => NUMBER.test(t) && /\d/.test(t));
    const named = tokens.filter((t) => !numbers.includes(t) && !wordsOf(t).every((w) => PRINTING_WORDS.has(w)));
    const words = named.some((t) => !wordsOf(t).every((w) => FILLER_WORDS.has(w))) ? named.filter((t) => !wordsOf(t).every((w) => FILLER_WORDS.has(w))) : named;
    // Only printing words ("holo"): nothing to search by.
    if (!words.length && !numbers.length) return { hits: [], more: false };
    const [sets, isPocket] = await Promise.all([this.details.json<SetBrief[]>('/sets'), this.details.pocketTest()]);
    const setList = Array.isArray(sets) ? sets : [];
    const setById = new Map(setList.map((s, i) => [s.id, { ...s, order: i }]));

    // Name runs to try, longest first ("base set charizard" → "base set charizard", "base set", "set charizard", …).
    const runs: { name: string; rest: string[] }[] = [];
    for (let len = words.length; len >= 1; len--) {
      for (let at = 0; at + len <= words.length; at++) {
        const run = words.slice(at, at + len);
        if (len === 1 && wordsOf(run[0]).join('').length < 3) continue;
        runs.push({ name: run.map(asPrinted).join(' '), rest: [...words.slice(0, at), ...words.slice(at + len)] });
      }
    }
    // The longest runs first, then every word on its own, so a name is found however many set words come with it.
    const longer = runs.filter((r) => r.name.includes(' ')).slice(0, MAX_TRIES);
    const tries = [...longer, ...runs.filter((r) => !r.name.includes(' '))].map((r) => ({ path: `/cards?name=${encodeURIComponent(r.name)}`, ...r }));
    // Only numbers: every card with the first one.
    const own = numbers[0]?.split('/')[0] ?? '';
    if (!words.length) tries.push({ path: `/cards?localId=${encodeURIComponent(/^\d+$/.test(own) ? String(Number(own)) : own)}`, name: '', rest: [] });

    for (const t of tries) {
      const list = await this.details.json<Brief[]>(t.path);
      const all = (Array.isArray(list) ? list : []).filter((c) => !isPocket(setOf(c)));
      const fits = (c: Brief, loose: boolean) => {
        const setId = setOf(c);
        const set = setById.get(setId);
        const setWords = wordsOf(set?.name ?? '');
        const nameWords = wordsOf(c.name);
        const inSetOrName = (w: string) => wordsOf(w).every((x) => setWords.some((s) => s.startsWith(x)) || nameWords.some((n) => n.startsWith(x)) || norm(setId) === x);
        const numberFits = (n: string) => {
          const [own, size] = n.split('/');
          if (cardNumber(own) !== cardNumber(c.localId)) return false;
          return !size || !/^\d+$/.test(size) || Number(size) === set?.cardCount?.official;
        };
        // A number is the card's number; failing that, part of its set's name ("151").
        return t.rest.every(inSetOrName) && numbers.every((n) => numberFits(n) || (loose && inSetOrName(n)));
      };
      // Cards with the number first, then those whose set's name has it.
      const exact = all.filter((c) => fits(c, false));
      const found = numbers.length ? [...exact, ...all.filter((c) => !exact.includes(c) && fits(c, true))] : exact;
      if (!found.length) continue;
      const wanted = norm(t.name);
      const restKey = norm(t.rest.join(''));
      const rank = (c: Brief) =>
        (exact.includes(c) ? 0 : 4) + (norm(c.name) === wanted ? 0 : norm(c.name).startsWith(wanted) ? 1 : 2) - (restKey && norm(setById.get(setOf(c))?.name) === restKey ? 0.5 : 0);
      // The card's number before its set's name; the exact name, the set named exactly; then newest
      // sets first (TCGdex lists sets oldest first), then by number.
      found.sort((a, b) => rank(a) - rank(b) || (setById.get(setOf(b))?.order ?? -1) - (setById.get(setOf(a))?.order ?? -1) || a.localId.localeCompare(b.localId, undefined, { numeric: true }));
      const hits = found.slice(0, MAX_HITS).map((c): LookupHit => {
        const set = setById.get(setOf(c));
        return { id: c.id, name: c.name, number: c.localId, total: set?.cardCount?.official || null, set: set?.name ?? setOf(c), thumb: c.image ? `${c.image}/low.webp` : null };
      });
      return { hits, more: found.length > MAX_HITS };
    }
    return { hits: [], more: false };
  }

  /** One card: its details, its printings and each one's prices today. */
  async card(id: string): Promise<LookupCard> {
    const td = await this.details.json<FullCard>(`/cards/${encodeURIComponent(id)}`);
    const info = await this.details.json<SetInfo>(`/sets/${encodeURIComponent(td.set.id)}`).catch(() => null);
    const notes: string[] = [];
    const rates = this.updater?.savedRates() ?? { usd: 1.37, eur: null };
    const schedule = this.updater?.schedule();
    const useCardmarket = (schedule?.cardmarket ?? true) && !!rates.eur;
    const method = this.updater?.priceMethod() ?? blend().settings(null);

    // Each TCGdex variant with its own prices; a card without a variant list, its printings' prices.
    const kinds = [
      { kind: 'normal', variant: '', label: 'regular' },
      { kind: 'holo', variant: 'Holo', label: 'holo' },
      { kind: 'reverse', variant: 'Reverse Holo', label: 'reverse' },
    ] as const;
    const base = (td.variants_detailed ?? []).length
      ? td.variants_detailed!.map((v) => {
          const p = variantPrices(v);
          return { label: variantLabel(v), variant: variantText(v), tcgplayer: p.tcgplayer, cardmarketEur: p.cardmarketEur };
        })
      : kinds
          .map((k) => {
            const want = { kind: k.kind, first: false, strict: true };
            return { label: k.label, variant: k.variant, tcgplayer: tcgdexTcgplayer(td, want), cardmarketEur: tcgdexCardmarket(td, want) };
          })
          .filter((p, i) => i === 0 || p.tcgplayer || p.cardmarketEur != null);

    let products: PcProduct[] = [];
    if (this.updater) {
      try {
        products = await this.updater.lookupProducts(searchQuery({ name: td.name, number: td.localId }));
      } catch (err) {
        notes.push(`No PriceCharting prices: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const asked = !!this.updater && !notes.length;

    const printings = base.map((p): LookupPrinting => {
      const card = { name: td.name, number: td.localId, set: td.set.name, variant: p.variant };
      const pc = asked ? (chooseMatch(card, products).match as PcProduct | null) : null;
      const quotes: Record<string, number> = {};
      if (pc?.usd != null) quotes.pricecharting = pc.usd;
      if (p.tcgplayer) quotes.tcgplayer = p.tcgplayer.usd;
      if (useCardmarket && p.cardmarketEur != null) quotes.cardmarket = round2((p.cardmarketEur * rates.eur!) / rates.usd);
      // As the daily update does: TCGdex's prices count only when its card is PriceCharting's product's set and printing.
      const leftOut = quotes.pricecharting != null ? catalogMismatch(card, pc, td.set.name) : null;
      if (leftOut) {
        delete quotes.tcgplayer;
        delete quotes.cardmarket;
      }
      const picked = blend().price(quotes, method);
      const grades = Object.entries(pc?.grades ?? {}).map(([label, usd]) => ({ label, usd, cad: round2(usd * rates.usd) }));
      return {
        label: p.label,
        variant: p.variant,
        tcgplayer: p.tcgplayer ? { usd: p.tcgplayer.usd, url: p.tcgplayer.productId ? `https://www.tcgplayer.com/product/${p.tcgplayer.productId}` : null } : null,
        cardmarket: p.cardmarketEur != null ? { eur: p.cardmarketEur } : null,
        pricecharting: pc ? { id: pc.id, url: pc.url, title: pc.title, usd: pc.usd, grades } : null,
        leftOut,
        price: picked ? { usd: picked.usd, cad: round2(picked.usd * rates.usd), where: picked.where, summary: picked.summary } : null,
      };
    });
    if (asked && !printings.some((p) => p.pricecharting)) notes.push('PriceCharting has no certain match for this card.');
    if (!useCardmarket && base.some((p) => p.cardmarketEur != null)) {
      notes.push(schedule?.cardmarket === false ? "Cardmarket's prices aren't counted: it's left out under Administration → Prices." : "Cardmarket's prices aren't counted until a price update has the euro's exchange rate.");
    }

    // The regular printing's TCGplayer picture is the largest; TCGdex's own otherwise.
    const product = base.find((p) => p.tcgplayer?.productId)?.tcgplayer?.productId;
    return {
      id: td.id,
      name: td.name,
      number: td.localId,
      total: td.set.cardCount?.official || null,
      set: td.set.name,
      setCode: info?.abbreviation?.official ?? info?.tcgOnline ?? null,
      rarity: mapRarity(td.rarity),
      artist: td.illustrator?.trim() || null,
      released: isoDate(info?.releaseDate),
      image: td.image ? `${td.image}/high.webp` : product ? tcgImage(product, 1000) : null,
      thumb: td.image ? `${td.image}/low.webp` : null,
      printings,
      rates,
      notes,
    };
  }
}
