import { asPrinted, cardNumber, norm, words } from './names.ts';
import { featuresOf, tcgdexTcgplayer, variantLabel, variantPrices } from './printings.ts';
import { isPocketSet, setOfCard, type TcgdexBrief, type TcgdexCard, type TcgdexSetBrief, thumbOf } from './tcgdex.ts';
import { tcgImage } from './tcgplayer.ts';

// Looking up any card, in the ledger or not (Find a card → Any card): searching the card database
// by name, set and number, and a card's printings with each one's prices on the card database.

/** One card found by a search. */
export interface LookupHit {
  /** TCGdex card id, e.g. "base1-4". */
  readonly id: string;
  readonly name: string;
  /** The number on the card, as TCGdex writes it ("004"). */
  readonly number: string;
  /** How many cards the set officially has (the "/102"); null when TCGdex doesn't say. */
  readonly total: number | null;
  readonly set: string;
  readonly thumb: string | null;
}

/** Most results a search returns. */
export const MAX_HITS = 48;
/** Most searches by runs of two or more words one query makes; each word on its own is tried too (each a TCGdex request, remembered for an hour). */
const MAX_TRIES = 6;
/** Words that name no card or set ("pokemon card"): left out when other words come with them. */
const FILLER_WORDS = new Set(['pokemon', 'card', 'cards', 'tcg']);
/** Words that say which printing, not which card: left out of the search ("pikachu base set holo"); the card view lists every printing. */
const PRINTING_WORDS = new Set(['holo', 'holofoil', 'foil', 'reverse', 'rev', 'rh', 'non', 'nonholo', 'normal', 'regular', 'unlimited', '1st', 'first', 'edition', 'ed', 'shadowless', 'stamp', 'stamped', 'pattern']);
/** A card number as typed: "4", "4/102", "SWSH050", "TG10", "GG01/GG70". */
const NUMBER = /^[a-z]{0,6}\d+[a-z]?(?:\/[a-z]{0,6}\d+)?$/i;

/** One search of the card database: cards with a name (a run of the query's words), or with a number. */
export interface SearchTry {
  readonly by: 'name' | 'number';
  /** The name or number searched for. */
  readonly value: string;
  /** The name searched for ("" when searching by number). */
  readonly name: string;
  /** The query's other words, each of which has to be in the card's set name or name. */
  readonly rest: readonly string[];
}

/** How a query is searched: its numbers, and the searches to try in turn until one finds cards. */
export interface SearchPlan {
  readonly numbers: readonly string[];
  readonly tries: readonly SearchTry[];
}

/**
 * The searches for a query, best first: the longest run of its words that names cards ("charizard
 * ex"), then shorter ones, then each word on its own, so a name is found however many set words
 * come with it. A query of only a number searches by that number. Null when there is nothing to
 * search by (no words, or only printing words such as "holo").
 */
export function searchPlan(query: string): SearchPlan | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length) return null;
  const numbers = tokens.filter((t) => NUMBER.test(t) && /\d/.test(t));
  const named = tokens.filter((t) => !numbers.includes(t) && !words(t).every((w) => PRINTING_WORDS.has(w)));
  const filler = (t: string) => words(t).every((w) => FILLER_WORDS.has(w));
  const wanted = named.some((t) => !filler(t)) ? named.filter((t) => !filler(t)) : named;
  if (!wanted.length && !numbers.length) return null;
  // Name runs to try, longest first ("base set charizard" → "base set charizard", "base set", "set charizard", …).
  const runs: SearchTry[] = [];
  for (let len = wanted.length; len >= 1; len--) {
    for (let at = 0; at + len <= wanted.length; at++) {
      const run = wanted.slice(at, at + len);
      if (len === 1 && words(run[0]).join('').length < 3) continue;
      const name = run.map(asPrinted).join(' ');
      runs.push({ by: 'name', value: name, name, rest: [...wanted.slice(0, at), ...wanted.slice(at + len)] });
    }
  }
  const tries = [...runs.filter((r) => r.name.includes(' ')).slice(0, MAX_TRIES), ...runs.filter((r) => !r.name.includes(' '))];
  // Only numbers: every card with the first one.
  if (!wanted.length) {
    const own = numbers[0]?.split('/')[0] ?? '';
    tries.push({ by: 'number', value: /^\d+$/.test(own) ? String(Number(own)) : own, name: '', rest: [] });
  }
  return { numbers, tries };
}

/**
 * The cards one search found that fit the query, best first; null when none does (the next search
 * is tried). Each of the query's other words has to be in the card's set name or name, and each
 * number has to be the card's number (or, failing that, part of its set's name: "151"). The card's
 * number before its set's name; the exact name, the set named exactly; then newest sets first
 * (TCGdex lists sets oldest first), then by number. TCG Pocket's cards are left out.
 */
export function searchHits(list: readonly TcgdexBrief[], t: SearchTry, numbers: readonly string[], sets: readonly TcgdexSetBrief[], pocketIds: ReadonlySet<string>): { readonly hits: LookupHit[]; readonly more: boolean } | null {
  const setById = new Map(sets.map((s, order) => [s.id, { set: s, order }]));
  const setOf = (c: TcgdexBrief) => setById.get(setOfCard(c))?.set;
  const all = list.filter((c) => !isPocketSet(setOfCard(c), pocketIds));
  const fits = (c: TcgdexBrief, loose: boolean) => {
    const setId = setOfCard(c);
    const setWords = words(setOf(c)?.name ?? '');
    const nameWords = words(c.name);
    const inSetOrName = (w: string) => words(w).every((x) => setWords.some((s) => s.startsWith(x)) || nameWords.some((n) => n.startsWith(x)) || norm(setId) === x);
    const numberFits = (n: string) => {
      const [own, size] = n.split('/');
      if (cardNumber(own) !== cardNumber(c.localId)) return false;
      return !size || !/^\d+$/.test(size) || Number(size) === setOf(c)?.cardCount?.official;
    };
    return t.rest.every(inSetOrName) && numbers.every((n) => numberFits(n) || (loose && inSetOrName(n)));
  };
  // Cards with the number first, then those whose set's name has it.
  const exact = all.filter((c) => fits(c, false));
  const found = numbers.length ? [...exact, ...all.filter((c) => !exact.includes(c) && fits(c, true))] : exact;
  if (!found.length) return null;
  const wanted = norm(t.name);
  const restKey = norm(t.rest.join(''));
  const rank = (c: TcgdexBrief) =>
    (exact.includes(c) ? 0 : 4) + (norm(c.name) === wanted ? 0 : norm(c.name).startsWith(wanted) ? 1 : 2) - (restKey && norm(setOf(c)?.name) === restKey ? 0.5 : 0);
  const order = (c: TcgdexBrief) => setById.get(setOfCard(c))?.order ?? -1;
  const sorted = [...found].sort((a, b) => rank(a) - rank(b) || order(b) - order(a) || a.localId.localeCompare(b.localId, undefined, { numeric: true }));
  const hits = sorted.slice(0, MAX_HITS).map((c): LookupHit => {
    const set = setOf(c);
    return { id: c.id, name: c.name, number: c.localId, total: set?.cardCount?.official || null, set: set?.name ?? setOfCard(c), thumb: thumbOf(c) };
  });
  return { hits, more: found.length > MAX_HITS };
}

/** What to type in a card's Variant for a TCGdex variant: "Master Ball", "1st Edition Holo", "Reverse Holo", "". */
export function variantText(v: Parameters<typeof variantLabel>[0]): string {
  const label = variantLabel(v);
  const features = featuresOf(v).length ? label.replace(/ (?:normal|regular|holo|reverse)$/, '') : '';
  const kind = v.type === 'reverse' ? 'Reverse Holo' : v.type === 'holo' ? 'Holo' : '';
  // A pattern names its printing on its own (a Poké Ball card is a reverse holo).
  return (v.foil ? features : [features, kind].filter(Boolean).join(' ')).trim();
}

/** One printing of a card (regular, reverse holo, a Poké Ball pattern, 1st Edition…) with its prices on the card database. */
export interface CardPrinting {
  /** In words: "Master Ball reverse", "regular". */
  readonly label: string;
  /** What to type in a card's Variant for this printing ("" for the regular card). */
  readonly variant: string;
  /** TCGplayer's market price (US$) and product, from the card database. */
  readonly tcgplayer: { readonly usd: number; readonly productId: string | null } | null;
  /** The printing's TCGplayer product, even without a price. */
  readonly product: string | null;
}

const KINDS = [
  { kind: 'normal', variant: '', label: 'regular' },
  { kind: 'holo', variant: 'Holo', label: 'holo' },
  { kind: 'reverse', variant: 'Reverse Holo', label: 'reverse' },
] as const;

/** Each TCGdex variant with its own prices; a card without a variant list, its printings' prices. */
export function printingsOf(td: TcgdexCard): CardPrinting[] {
  const detailed = td.variants_detailed ?? [];
  if (detailed.length)
    return detailed.map((v) => {
      const p = variantPrices(v);
      const product = p.tcgplayer?.productId ?? (v.thirdParty?.tcgplayer ? String(Math.trunc(v.thirdParty.tcgplayer)) : null);
      return { label: variantLabel(v), variant: variantText(v), tcgplayer: p.tcgplayer, product };
    });
  return KINDS.map((k): CardPrinting => {
    const want = { kind: k.kind, first: false, strict: true };
    const tcgplayer = tcgdexTcgplayer(td, want);
    return { label: k.label, variant: k.variant, tcgplayer, product: tcgplayer?.productId ?? null };
  }).filter((p, i) => i === 0 || p.tcgplayer);
}

/** A card's number as printed with its set size: "4" of 102 → "4/102"; others as they are. */
export const numberWithTotal = (localId: string, total: number | null): string => (total && /^\d+$/.test(localId) ? `${localId}/${total}` : localId);

/** A card's picture: the largest TCGdex has, else its TCGplayer product's. */
export const cardImage = (td: TcgdexCard, product: string | null | undefined): string | null => (td.image ? `${td.image}/high.webp` : product ? tcgImage(product, 1000) : null);
