import { DETAILS_VERSION } from '../cards/attention.ts';
import { type Fields, isRecord } from '../ledger/document.ts';
import { isBlank, isoDate, norm, ownNumber, searchWord, setLabel, setSize, similarity, withoutBrackets } from './names.ts';
import { mapRarity } from './rarity.ts';
import { isPocketSet, isSubSet, officialCount, releasedOf, setCodeOf, setOfCard, type TcgdexBrief, type TcgdexCard, type TcgdexSet, type TcgdexSetBrief, thumbOf } from './tcgdex.ts';

// A card's details from TCGdex: given its name and number, its set, official set code, rarity,
// illustrator and the set's release date (for sorting a binder by release). They fill in what a
// person didn't type when adding a card, and the blanks on cards already in the ledger. Only
// empty fields are ever filled: what the person typed always wins.

/** The card fields a lookup fills when they're empty. */
export const DETAIL_FIELDS = ['set', 'setCode', 'rarity', 'artist', 'released'] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];

/** How a lookup ended, as recorded on the card. */
export type LookupResult = 'filled' | 'complete' | 'several' | 'notFound' | 'error';

/** A TCGdex card that may be the person's. */
export interface DetailsMatch {
  /** TCGdex card id, e.g. "sv05-051". */
  readonly id: string;
  /** TCGdex set id, e.g. "sv05". */
  readonly setId: string;
  readonly name: string;
  /** The number on the card, as TCGdex writes it ("051"). */
  readonly number: string;
  readonly set: string;
  readonly setCode: string | null;
  /** How many cards the set officially has (the "/162"); null for promos. */
  readonly total: number | null;
  readonly rarity: string | null;
  readonly artist: string | null;
  /** When the card's set came out, YYYY-MM-DD. */
  readonly released: string | null;
  /** Small picture for choosing between matches. */
  readonly thumb: string | null;
}

/** A TCGdex card offered to the person: one of several matches, or a name they may have meant. */
export interface DetailsOption {
  readonly id: string;
  readonly name: string;
  readonly set: string;
  readonly setCode: string | null;
  readonly number: string;
  readonly total: number | null;
  readonly thumb: string | null;
}

/** What the person typed about the card's set, which narrows the matches. */
export interface SetHints {
  readonly set?: string | null | undefined;
  readonly setCode?: string | null | undefined;
}

/** What the last lookup for a card found, stored on the card as `details`. */
export interface DetailsStatus {
  readonly source: 'tcgdex';
  readonly result: LookupResult;
  /** Which checks the lookup made (DETAILS_VERSION); older lookups are redone once. */
  readonly v?: number | undefined;
  readonly id?: string | null | undefined;
  readonly filled?: readonly DetailField[] | null | undefined;
  readonly error?: string | null | undefined;
  /** The matched card's set as TCGdex has it (the person's own label for it may differ). */
  readonly setId?: string | null | undefined;
  readonly set?: string | null | undefined;
  readonly setCode?: string | null | undefined;
  /** The set's release date found with the match. */
  readonly released?: string | null | undefined;
  /** The card is filed under a different set than the one its name and number belong to. */
  readonly filedUnder?: FiledUnder | null | undefined;
  /** Several cards match: the choices. */
  readonly options?: readonly DetailsOption[] | null | undefined;
  /** Not found, but a card with that number has a similar name. */
  readonly suggest?: readonly DetailsOption[] | null | undefined;
  /** The person chose this match (from several, or in Cards to check): it's never replaced by a lookup. */
  readonly chosen?: boolean | null | undefined;
  /** A match in a reprint sub-set (30th Classic Collection): the set it belongs to (30th Celebration). */
  readonly parentSet?: string | null | undefined;
  readonly checkedAt: string;
}

/** A TCGdex set a label names exactly ("Pokemon Crown Zenith" → swsh12.5). */
export interface NamedSet {
  readonly id: string;
  readonly name: string;
  readonly released: string | null;
}

export const option = (m: DetailsMatch): DetailsOption => ({ id: m.id, name: m.name, set: m.set, setCode: m.setCode, number: m.number, total: m.total, thumb: m.thumb });

/** A TCGdex card, with its set's code and release date, as a match. */
export function matchOf(c: TcgdexCard, s: TcgdexSet | null): DetailsMatch {
  return {
    id: c.id,
    setId: c.set.id,
    name: c.name,
    number: c.localId,
    set: c.set.name,
    setCode: setCodeOf(s),
    total: officialCount(c.set),
    rarity: mapRarity(c.rarity),
    artist: c.illustrator?.trim() || null,
    released: releasedOf(s),
    thumb: thumbOf(c),
  };
}

// ---- finding the card ----------------------------------------------------------------

/** What a card is searched by: a word of its name, its own number, and the names it could have. */
export interface CardQuery {
  readonly word: string;
  readonly own: string;
  readonly names: ReadonlySet<string>;
}

/** The search for a card's name and number; null without either. */
export function cardQuery(name: string, number: string): CardQuery | null {
  const word = searchWord(name);
  const own = ownNumber(number);
  if (!word || !own) return null;
  return { word, own, names: new Set([norm(name), norm(withoutBrackets(name))]) };
}

/** The cards a search found that are this card (its name and number), never TCG Pocket's; at most 12. */
export const sameCards = (list: readonly TcgdexBrief[], q: CardQuery, pocketIds: ReadonlySet<string>): TcgdexBrief[] =>
  list.filter((c) => q.names.has(norm(c.name)) && ownNumber(c.localId) === q.own && !isPocketSet(setOfCard(c), pocketIds)).slice(0, 12);

/** The cards of a set (a reprint sub-set) with one of the card's names. */
export const namedIn = (cards: readonly TcgdexBrief[], q: CardQuery): TcgdexBrief[] => cards.filter((c) => q.names.has(norm(c.name)));

/** Matches narrowed by `keep`, unless none would be left. */
const narrowed = (matches: readonly DetailsMatch[], keep: (m: DetailsMatch) => boolean): readonly DetailsMatch[] => {
  const n = matches.filter(keep);
  return n.length ? n : matches;
};

/** The matches narrowed by the set size typed ("51/162"), then the set code and set the person already typed. */
export function narrowByHints(matches: readonly DetailsMatch[], number: string, hints: SetHints): readonly DetailsMatch[] {
  let out = matches;
  const size = setSize(number);
  if (size != null) out = narrowed(out, (m) => m.total === size);
  if (!isBlank(hints.setCode)) out = narrowed(out, (m) => norm(m.setCode) === norm(hints.setCode));
  if (!isBlank(hints.set)) out = narrowed(out, (m) => norm(m.set).includes(norm(hints.set).replace(/^pokemon/, '')) || norm(hints.set).includes(norm(m.set)));
  return out;
}

/** The set a card is filed under and its reprint sub-sets (which keep the original's number). */
export const inFamily = (familyId: string, setId: string): boolean => setId === familyId || isSubSet(familyId, setId);

/**
 * The matches in the set the card is filed under (and its sub-sets), when there are any; `none`
 * when there are none, so its sub-sets are searched by name instead of taking a card from an
 * unrelated set that only shares the number.
 */
export function narrowToFamily(matches: readonly DetailsMatch[], familyId: string): { readonly matches: readonly DetailsMatch[]; readonly none: boolean } {
  const out = narrowed(matches, (m) => inFamily(familyId, m.setId));
  return { matches: out, none: !out.some((m) => inFamily(familyId, m.setId)) };
}

/** Most matches offered. */
export const MAX_MATCHES = 8;

/** The set with exactly this name (however it's written), of those TCGdex found by it. */
export const setNamedExactly = (sets: readonly TcgdexSetBrief[], name: string): TcgdexSetBrief | null => sets.find((x) => norm(x.name) === norm(name)) ?? null;

const SIMILAR = 0.8;

/** Cards with the card's number whose names are close to the one typed (a misspelling such as "Eelktross"), closest first. */
export function closeNames(list: readonly TcgdexBrief[], name: string, own: string): TcgdexBrief[] {
  return list
    .filter((c) => ownNumber(c.localId) === own)
    .map((c) => ({ c, sim: Math.max(similarity(name, c.name), similarity(withoutBrackets(name), c.name)) }))
    .filter((x) => x.sim >= SIMILAR)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 6)
    .map((x) => x.c);
}

/**
 * The names to suggest for a card not found. A suggestion has to agree with something typed about
 * the set, when anything was: a lookalike from an unrelated set (Nidorino for a Nidorina promo
 * TCGdex lacks) would mislead.
 */
export function suggestions(matches: readonly DetailsMatch[], number: string, hints: SetHints): DetailsOption[] {
  const size = setSize(number);
  const told = size != null || !isBlank(hints.setCode) || !isBlank(hints.set);
  const agrees = (m: DetailsMatch) =>
    (size != null && m.total === size) || (!isBlank(hints.setCode) && norm(m.setCode) === norm(hints.setCode)) || (!isBlank(hints.set) && norm(m.set) === norm(setLabel(hints.set)));
  return (told ? matches.filter(agrees) : matches).slice(0, 3).map(option);
}

// ---- the set a card is filed under -----------------------------------------------------

/** The card is filed under a different set than the one its name and number belong to. */
export interface FiledUnder {
  readonly as: string;
  readonly id: string;
  readonly name: string;
}

/** A match checked against the set the card is filed under. */
export interface Filing {
  readonly released: string | null;
  readonly filedUnder: FiledUnder | null;
  /** A match in a reprint sub-set (30th Classic Collection): the set it belongs to (30th Celebration). */
  readonly parentSet?: string | undefined;
}

const isPromo = (m: DetailsMatch) => /promo/i.test(m.set);

/** The label of the set the card is filed under, when it isn't the match's own set and has to be looked up. */
export function filingLabel(m: DetailsMatch, filedUnder: unknown): string | null {
  const label = setLabel(filedUnder);
  return !label || norm(label) === norm(m.set) ? null : label;
}

/**
 * Check a match against the set the card is filed under (`named`: that set, when TCGdex knows it
 * by that exact name). A promo set's date is when that promo series began (SWSH Black Star Promos:
 * 2019), so a promo filed under a set by name ("Crown Zenith") takes that set's date. Any other
 * card filed under a set TCGdex knows by that exact name, but which belongs to a different set, is
 * flagged (Bill 118/130 filed under Base Set is from Base Set 2). Labels TCGdex doesn't know
 * ("Scarlet & Violet Base") aren't errors.
 */
export function filing(m: DetailsMatch, filedUnder: unknown, named: NamedSet | null): Filing {
  if (!named || named.id === m.setId) return { released: m.released, filedUnder: null };
  // A reprint sub-set (30th Classic Collection) is part of the set it's filed under.
  if (isSubSet(named.id, m.setId)) return { released: m.released ?? named.released, filedUnder: null, parentSet: named.name };
  if (isPromo(m)) return { released: named.released ?? m.released, filedUnder: null };
  return { released: m.released, filedUnder: { as: String(filedUnder), id: named.id, name: named.name } };
}

/** A set found by name, with its release date. */
export const namedSet = (s: TcgdexSetBrief, info: TcgdexSet | null): NamedSet => ({ id: s.id, name: s.name, released: isoDate(info?.releaseDate) });

// ---- what a card's last lookup recorded --------------------------------------------------

/** Cards already looked up are tried again after this long, in case TCGdex has added them. */
const RECHECK_MS = 7 * 86_400_000;

/** What a failed lookup keeps of the card's match. */
const KEPT_ON_ERROR = ['v', 'id', 'setId', 'set', 'setCode', 'released', 'filedUnder', 'parentSet', 'chosen'] as const;

/** The card's last lookup (its `details`), or null. */
const lastLookup = (card: Fields): Readonly<Record<string, unknown>> | null => {
  const d = card['details'];
  return isRecord(d) ? d : null;
};

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The TCGdex card the last lookup matched, whether the person chose it, and with which checks. */
export function lastMatch(card: Fields): { readonly id: string | null; readonly chosen: boolean; readonly current: boolean } {
  const d = lastLookup(card);
  return { id: text(d?.['id']), chosen: !!d?.['chosen'], current: d?.['v'] === DETAILS_VERSION };
}

/** The fields the last lookup filled. */
export const lastFilled = (card: Fields): string[] => {
  const filled = lastLookup(card)?.['filled'];
  return Array.isArray(filled) ? filled.map(String) : [];
};

/** Whether the card was ever looked up. */
export const lookedUp = (card: Fields): boolean => !!text(lastLookup(card)?.['checkedAt']);

/** Looked up (matched, not found or several) before the current checks were made. */
export function outdated(card: Fields): boolean {
  const last = lastLookup(card);
  if (!text(last?.['checkedAt']) || last?.['v'] === DETAILS_VERSION) return false;
  return !!last?.['id'] || last?.['result'] === 'notFound' || last?.['result'] === 'several';
}

const englishOrUnset = (lang: unknown) => isBlank(lang) || /^en/i.test(String(lang));

/**
 * Whether a card has blanks a lookup could fill and hasn't been looked up recently (`force`: even
 * then). A card looked up before the current checks is wanted straight away, complete or not (a
 * matched one is one quick fetch by its id).
 */
export function wantsDetails(card: Fields | undefined, now: Date, force = false): boolean {
  if (!card || isBlank(card['name']) || isBlank(card['number']) || !englishOrUnset(card['language'])) return false;
  if (outdated(card)) return true;
  if (!DETAIL_FIELDS.some((f) => isBlank(card[f]))) return false;
  const checkedAt = text(lastLookup(card)?.['checkedAt']);
  if (force || !checkedAt) return true;
  return now.getTime() - Date.parse(checkedAt) > RECHECK_MS;
}

/** The fields of `card` that are empty and that `m` knows. */
export function patchFor(card: Fields, m: DetailsMatch): { patch: Record<string, string>; filled: DetailField[] } {
  const values: Record<DetailField, string | null> = { set: m.set, setCode: m.setCode, rarity: m.rarity, artist: m.artist, released: m.released };
  const patch: Record<string, string> = {};
  const filled: DetailField[] = [];
  for (const f of DETAIL_FIELDS) {
    const v = values[f];
    if (isBlank(card[f]) && v !== null && !isBlank(v)) {
      patch[f] = v;
      filled.push(f);
    }
  }
  return { patch, filled };
}

/** What a lookup found for a card. */
export type LookupFound =
  /** Exactly one card: its blanks are filled from it. `chosen`: the person chose it, so a lookup never replaces it. */
  | { readonly kind: 'one'; readonly match: DetailsMatch; readonly filing: Filing; readonly chosen: boolean }
  | { readonly kind: 'several'; readonly options: readonly DetailsMatch[] }
  /** Nothing, but perhaps a name the person meant. */
  | { readonly kind: 'none'; readonly suggest: readonly DetailsOption[] }
  /**
   * The card database didn't answer: the match the card had (and whether the person chose it)
   * stays for the next lookup, unless the card database no longer has that card (`gone`), when
   * it's searched for by name and number again.
   */
  | { readonly kind: 'failed'; readonly message: string; readonly gone: boolean };

/** The card's empty details filled from what a lookup found, and the lookup recorded as `details`. */
export function lookupRecord(card: Fields, found: LookupFound, checkedAt: string): { readonly patch: Record<string, unknown>; readonly result: LookupResult } {
  const base = { source: 'tcgdex', v: DETAILS_VERSION, checkedAt };
  switch (found.kind) {
    case 'one': {
      const { filing: f, chosen } = found;
      const m = { ...found.match, released: f.released };
      const { patch, filled } = patchFor(card, m);
      const result: LookupResult = filled.length ? 'filled' : 'complete';
      const details = {
        ...base,
        result,
        id: m.id,
        filled,
        setId: m.setId,
        set: m.set,
        setCode: m.setCode,
        released: m.released,
        filedUnder: f.filedUnder,
        ...(f.parentSet ? { parentSet: f.parentSet } : {}),
        ...(chosen ? { chosen: true } : {}),
      };
      return { patch: { ...patch, details }, result };
    }
    case 'several':
      return { patch: { details: { ...base, result: 'several', options: found.options.map(option) } }, result: 'several' };
    case 'none':
      return { patch: { details: { ...base, result: 'notFound', suggest: found.suggest.length ? found.suggest : null } }, result: 'notFound' };
    case 'failed': {
      const prev = lastLookup(card);
      const kept: Record<string, unknown> = {};
      if (prev && text(prev['id']) && !found.gone) for (const k of KEPT_ON_ERROR) if (prev[k] != null) kept[k] = prev[k];
      return { patch: { details: { ...kept, source: 'tcgdex', result: 'error', error: found.message, checkedAt } }, result: 'error' };
    }
  }
}

/**
 * A card that became a different one (a CSV row replacing it, its name or number edited): its
 * TCGdex match and release date were for the old card, and so was an automatic price match (one the
 * person chose is kept). The other site's product goes the same way, unless the person chose it
 * or turned that site off.
 */
export function formerCardForgotten(card: Fields): Record<string, unknown> {
  const link = card['pricing'];
  const reset: Record<string, unknown> = { details: null, released: null };
  if (!isRecord(link)) return reset;
  const pair = link['pair'];
  if (link['linkedBy'] !== 'user') return { ...reset, pricing: null, officialImageId: null };
  if (isRecord(pair) && pair['linkedBy'] !== 'user' && !pair['off']) return { ...reset, pricing: { ...link, pair: null } };
  return reset;
}

/** What makes a card that card: its name and number, however they're spaced or capitalised. */
export const cardIdentity = (c: Fields): string => `${String(c['name'] ?? '').trim().toLowerCase()}\u0000${String(c['number'] ?? '').replace(/\s+/g, '').toLowerCase()}`;

/** A card in words, for the log: "Pikachu TEF 51/162". */
export const cardLabel = (c: Fields): string => [c['name'] || 'Unnamed card', c['setCode'] || c['set'], c['number']].filter(Boolean).join(' ');
