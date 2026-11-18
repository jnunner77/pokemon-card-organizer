import { type LookupHit, MAX_HITS } from './any-card.ts';
import { type DetailsMatch, MAX_MATCHES, type NamedSet, SIMILAR, type SetHints } from './details.ts';
import { isBlank, norm, setSize, similarity, withoutBrackets, words } from './names.ts';
import { mapRarity } from './rarity.ts';
import { extended, ownNumber, productName, setName, type TcgGroup, type TcgPrice, type TcgProduct, tcgImage } from './tcgplayer.ts';

// Japanese cards: TCGplayer's Japanese catalog (tcgcsv.com category 85) kept as a compact index
// of every set and its cards, so a Japanese card can be found by its English name alone, filled
// in like an English one, and shown in Find a card. The index is built once and then refreshed
// for the sets that changed; this file is the rules, the application does the downloading.

export { catalogLanguage } from './names.ts';

/** One Japanese set (a TCGplayer "group") as the index keeps it. */
export interface JapaneseSet {
  readonly groupId: number;
  /** Without TCGplayer's series prefix: "Scarlet & Violet 151". */
  readonly name: string;
  /** As TCGplayer writes it, with the prefix: "SV2a: Pokemon Card 151". */
  readonly fullName: string;
  /** The set code ("SV2a"), when TCGplayer has one. */
  readonly code: string | null;
  /** YYYY-MM-DD. */
  readonly released: string | null;
  /** TCGplayer's modifiedOn when the set was downloaded: a different one means download it again. */
  readonly modifiedOn: string;
  /** When the set was downloaded (ISO). */
  readonly fetchedAt: string;
}

/** One Japanese card, with only what lookups need. */
export interface JapaneseCard {
  readonly productId: number;
  /** "Pikachu". */
  readonly name: string;
  /** What the product's brackets say: "Poke Ball Pattern". */
  readonly variant: string;
  /** As printed: "025/165". */
  readonly number: string;
  readonly rarity: string | null;
}

/** What the index keeps and saves. */
export interface JapaneseIndexData {
  readonly version: 1;
  /** When the last complete build or refresh finished (ISO); null while the first build hasn't. */
  readonly completedAt: string | null;
  readonly sets: readonly { readonly set: JapaneseSet; readonly cards: readonly JapaneseCard[] }[];
}

/** A card with its set and the keys lookups compare. */
export interface JapaneseEntry {
  readonly card: JapaneseCard;
  readonly set: JapaneseSet;
  /** The card's name's words: "pikachu ex". */
  readonly key: string;
  /** The card's own number: "25". */
  readonly own: string;
  /** The set size after the slash: 165. */
  readonly size: number | null;
}

/** Most cards one set may add to the index. */
export const MAX_CARDS_PER_SET = 3000;
/** Most cards the index holds. */
export const MAX_CARDS = 120_000;
/** Sets downloaded again each day even if they didn't change, oldest first. */
export const ROTATE_PER_DAY = 10;
/** A set not downloaded for this long is a candidate for that. */
export const STALE_AFTER_DAYS = 45;
/** A Japanese card's id: "ja-<TCGplayer group>-<TCGplayer product>". */
export const JAPANESE_MATCH = /^ja-(\d{1,9})-(\d{1,12})$/;

const DAY_MS = 86_400_000;

// ---- ids ---------------------------------------------------------------------------------

export const japaneseMatchId = (groupId: number, productId: number): string => `ja-${groupId}-${productId}`;

export function parseJapaneseMatchId(id: unknown): { readonly groupId: number; readonly productId: number } | null {
  const m = typeof id === 'string' ? JAPANESE_MATCH.exec(id) : null;
  return m ? { groupId: Number(m[1]), productId: Number(m[2]) } : null;
}

/** Which catalog a match id is from: Japanese ids start "ja-<group>-<product>", TCGdex's don't. */
export const matchLanguage = (id: string): 'en' | 'ja' => (parseJapaneseMatchId(id) ? 'ja' : 'en');

/** A Japanese match id's TCGplayer product, as a string; null for any other id. */
export const japaneseProductOf = (id: unknown): string | null => {
  const p = parseJapaneseMatchId(id);
  return p ? String(p.productId) : null;
};

// ---- reading TCGplayer's catalog ---------------------------------------------------------------

/** A set's release date when TCGplayer's publishedOn is a date (midnight), not a "now" stamp. */
export function releasedOfGroup(g: TcgGroup): string | null {
  const p = g.publishedOn ?? '';
  return /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?Z?$/.test(p) ? p.slice(0, 10) : null;
}

export function japaneseSetOf(g: TcgGroup, fetchedAt: string): JapaneseSet {
  const code = g.abbreviation?.trim();
  return { groupId: g.groupId, name: setName(g), fullName: g.name, code: code || null, released: releasedOfGroup(g), modifiedOn: g.modifiedOn ?? '', fetchedAt };
}

/** The cards among a set's products (those with a Number; sealed products have none). */
export function japaneseCardsOf(products: readonly TcgProduct[]): JapaneseCard[] {
  const seen = new Set<number>();
  const cards: JapaneseCard[] = [];
  for (const p of products) {
    const number = extended(p, 'Number')?.trim();
    if (!number || seen.has(p.productId)) continue;
    seen.add(p.productId);
    const { base, variant } = productName(p.name);
    cards.push({ productId: p.productId, name: base, variant, number, rarity: extended(p, 'Rarity')?.trim() || null });
    if (cards.length >= MAX_CARDS_PER_SET) break;
  }
  return cards;
}

export function entriesOf(set: JapaneseSet, cards: readonly JapaneseCard[]): JapaneseEntry[] {
  return cards.map((card) => ({ card, set, key: words(card.name).join(' '), own: ownNumber(card.number), size: setSize(card.number) }));
}

// ---- refreshing the index ----------------------------------------------------------------------

/**
 * What a daily refresh does: the sets to download (new or changed ones, newest first so new sets
 * are usable earliest, then a few of the oldest-downloaded as a safety net), the sets to drop
 * (TCGplayer no longer lists them), and the other sets with their names, codes and dates updated.
 */
export function refreshPlan(stored: readonly JapaneseSet[], groups: readonly TcgGroup[], now: Date): { fetch: number[]; drop: number[]; meta: JapaneseSet[] } {
  const have = new Map(stored.map((s) => [s.groupId, s]));
  const listed = new Map(groups.map((g) => [g.groupId, g]));
  const changed = groups
    .filter((g) => {
      const s = have.get(g.groupId);
      return !s || s.modifiedOn !== (g.modifiedOn ?? '');
    })
    .sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? ''));
  const fetch = changed.map((g) => g.groupId);
  const cutoff = now.getTime() - STALE_AFTER_DAYS * DAY_MS;
  const stale = stored
    .filter((s) => listed.has(s.groupId) && !fetch.includes(s.groupId) && Date.parse(s.fetchedAt) < cutoff)
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
    .slice(0, ROTATE_PER_DAY);
  fetch.push(...stale.map((s) => s.groupId));
  const drop = stored.filter((s) => !listed.has(s.groupId)).map((s) => s.groupId);
  const meta: JapaneseSet[] = [];
  for (const s of stored) {
    const g = listed.get(s.groupId);
    if (!g || fetch.includes(s.groupId)) continue;
    meta.push({ ...japaneseSetOf(g, s.fetchedAt), modifiedOn: s.modifiedOn });
  }
  return { fetch, drop, meta };
}

/** TCGplayer's catalog is refreshed around 20:00 UTC: the index is refreshed at 21:00 UTC. */
const REFRESH_HOUR_UTC = 21;

const refreshOn = (now: Date, daysAfter = 0): number => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAfter, REFRESH_HOUR_UTC);

/** The next 21:00 UTC after `now`. */
export const nextRefresh = (now: Date): Date => new Date(refreshOn(now) > now.getTime() ? refreshOn(now) : refreshOn(now, 1));

/** The index was completed at or after the most recent 21:00 UTC: nothing newer to fetch yet. */
export function isCurrent(completedAt: string | null, now: Date): boolean {
  if (!completedAt) return false;
  const last = refreshOn(now) <= now.getTime() ? refreshOn(now) : refreshOn(now, -1);
  return Date.parse(completedAt) >= last;
}

// ---- looking cards up ----------------------------------------------------------------------------

/** The part of a number before the slash, as printed: "025/165" → "025". */
export const localOf = (number: string): string => (number.split('/')[0] ?? '').trim();

const releasedFirst = (a: JapaneseEntry, b: JapaneseEntry): number => (b.set.released ?? '').localeCompare(a.set.released ?? '');

/** Entries narrowed by `keep`, unless none would be left. */
const narrowed = (entries: readonly JapaneseEntry[], keep: (e: JapaneseEntry) => boolean): readonly JapaneseEntry[] => {
  const n = entries.filter(keep);
  return n.length ? n : entries;
};

const sameSetName = (set: JapaneseSet, label: string): boolean => {
  const w = words(label).join(' ');
  return !!w && (words(set.name).join(' ') === w || words(set.fullName).join(' ') === w);
};

/** The cards with this name and number, narrowed by the set size typed and the set or set code, newest set first. */
export function lookupJapanese(entries: readonly JapaneseEntry[], name: string, number: string, hints: SetHints): JapaneseEntry[] {
  const own = ownNumber(number);
  const typed = words(withoutBrackets(name)).length ? words(withoutBrackets(name)) : words(name);
  if (!own || !typed.length) return [];
  const size = setSize(number);
  const sameNumber = entries.filter((e) => e.own === own && (size == null || e.size == null || e.size === size));
  const key = typed.join(' ');
  const exact = sameNumber.filter((e) => e.key === key);
  let out: readonly JapaneseEntry[] = exact.length ? exact : sameNumber.filter((e) => typed.every((w) => e.key.split(' ').includes(w)));
  if (!isBlank(hints.setCode)) out = narrowed(out, (e) => norm(e.set.code) === norm(hints.setCode));
  if (!isBlank(hints.set)) out = narrowed(out, (e) => sameSetName(e.set, String(hints.set)));
  return [...out].sort(releasedFirst).slice(0, MAX_MATCHES);
}

const NUMBER_TOKEN = /^[a-z-]*\d+[a-z]*(\/[a-z0-9-]+)?$/i;

/**
 * Find a card → Any card for Japanese cards: every word of the query has to be in a card's name or
 * its set's name, a number narrows by the card's number (and its set size when typed "25/165"), and
 * a set code (the lower-cased `codes`) by its set. Exact names first, then names starting with the
 * words, then the rest; newest sets first. Null when the query has no words.
 */
export function searchJapanese(entries: readonly JapaneseEntry[], query: string, codes: ReadonlySet<string>): { entries: JapaneseEntry[]; more: boolean } | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length) return null;
  const codeTokens: string[] = [];
  const numberTokens: string[] = [];
  const textTokens: string[] = [];
  for (const t of tokens) {
    if (codes.has(t.toLowerCase())) codeTokens.push(t.toLowerCase());
    else if (/\d/.test(t) && NUMBER_TOKEN.test(t)) numberTokens.push(t);
    else textTokens.push(t);
  }
  const wanted = words(textTokens.join(' ')).join(' ');
  const found = entries.filter((e) => {
    if (!codeTokens.every((c) => (e.set.code ?? '').toLowerCase() === c)) return false;
    if (!numberTokens.every((n) => ownNumber(n) === e.own && (setSize(n) == null || setSize(n) === e.size))) return false;
    const hay = `${e.key} ${words(e.set.name).join(' ')}`;
    return textTokens.every((t) => words(t).every((w) => hay.includes(w)));
  });
  const rank = (e: JapaneseEntry): number => (!wanted || e.key === wanted ? 0 : e.key.startsWith(wanted) ? 1 : 2);
  const sorted = found.sort((a, b) => rank(a) - rank(b) || releasedFirst(a, b) || a.own.localeCompare(b.own, undefined, { numeric: true }));
  return { entries: sorted.slice(0, MAX_HITS), more: sorted.length > MAX_HITS };
}

/** A Japanese card as a search lists it. */
export const japaneseHit = (e: JapaneseEntry): LookupHit => ({
  id: japaneseMatchId(e.set.groupId, e.card.productId),
  name: e.card.name + (e.card.variant ? ` (${e.card.variant})` : ''),
  number: localOf(e.card.number),
  total: e.size,
  set: e.set.name,
  thumb: tcgImage(e.card.productId, 200),
});

/** A Japanese card as a lookup's match; the illustrator comes from TCGdex's Japanese API (null when unknown). */
export const japaneseMatch = (e: JapaneseEntry, artist: string | null): DetailsMatch => ({
  id: japaneseMatchId(e.set.groupId, e.card.productId),
  setId: `ja-${e.set.groupId}`,
  name: e.card.name,
  number: localOf(e.card.number),
  set: e.set.name,
  setCode: e.set.code,
  total: e.size,
  rarity: mapRarity(e.card.rarity),
  artist,
  released: e.set.released,
  thumb: tcgImage(e.card.productId, 200),
});

/** The set a label names exactly (by its name with or without TCGplayer's prefix), or null. */
export function japaneseSetNamed(sets: readonly JapaneseSet[], label: string): NamedSet | null {
  const s = sets.find((x) => sameSetName(x, label));
  return s ? { id: `ja-${s.groupId}`, name: s.name, released: s.released } : null;
}

/** Cards with this number whose names are close to the one typed (a misspelling), as suggestions' matches. */
export function closeJapaneseNames(entries: readonly JapaneseEntry[], name: string, own: string): JapaneseEntry[] {
  return entries
    .filter((e) => e.own === own)
    .map((e) => ({ e, sim: Math.max(similarity(name, e.card.name), similarity(withoutBrackets(name), e.card.name)) }))
    .filter((x) => x.sim >= SIMILAR)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 6)
    .map((x) => x.e);
}

// ---- a card's printings and prices ------------------------------------------------------------------

/** One printing of a Japanese card with TCGplayer's market price (US$), null when it has none. */
export interface JapanesePrinting {
  readonly label: string;
  readonly variant: string;
  readonly usd: number | null;
}

const PRINTING_ORDER = ['Normal', 'Holofoil', 'Reverse Holofoil'];

/** A product's printings from its group's prices: Normal, Holofoil, Reverse Holofoil, then any other. */
export function japanesePrintings(prices: readonly TcgPrice[], productId: number, bracketVariant: string): JapanesePrinting[] {
  const mine = prices.filter((p) => p.productId === productId);
  const rank = (s: string) => {
    const i = PRINTING_ORDER.indexOf(s);
    return i < 0 ? PRINTING_ORDER.length : i;
  };
  const out = [...mine]
    .sort((a, b) => rank(a.subTypeName) - rank(b.subTypeName))
    .map((p): JapanesePrinting => {
      const label = p.subTypeName === 'Normal' ? 'regular' : p.subTypeName === 'Holofoil' ? 'holo' : p.subTypeName === 'Reverse Holofoil' ? 'reverse holo' : p.subTypeName.toLowerCase();
      const variant = bracketVariant.trim() ? bracketVariant : p.subTypeName === 'Reverse Holofoil' ? 'Reverse Holo' : '';
      return { label, variant, usd: p.marketPrice ?? p.midPrice ?? null };
    });
  return out.length ? out : [{ label: 'regular', variant: bracketVariant, usd: null }];
}
