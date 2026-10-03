// Card details from TCGdex (https://tcgdex.dev), a free, open database of Pokémon cards: given a
// card's name and number, its set, official set code, rarity, illustrator and the set's release
// date (for sorting a binder by release). Used to fill in
// what a person didn't type when adding a card, and the blanks on cards already in the ledger.
// Only empty fields are ever filled: what the person typed always wins.

import { type Fetcher, SourceError, get } from './pricing/sources';
import type { Doc } from './schema';
import type { Store } from './store';

const API = 'https://api.tcgdex.net/v2/en';

/** The card fields this fills when they're empty. */
export const DETAIL_FIELDS = ['set', 'setCode', 'rarity', 'artist', 'released'] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];

export interface DetailsMatch {
  /** TCGdex card id, e.g. "sv05-051". */
  id: string;
  name: string;
  /** The number on the card, as TCGdex writes it ("051"). */
  number: string;
  set: string;
  setCode: string | null;
  /** How many cards the set officially has (the "/162"); null for promos. */
  total: number | null;
  rarity: string | null;
  artist: string | null;
  /** When the card's set came out, YYYY-MM-DD. */
  released: string | null;
  /** Small picture for choosing between matches. */
  thumb: string | null;
}

/** What the last lookup for a card found, stored on the card as `details`. */
export interface DetailsStatus {
  source: 'tcgdex';
  result: 'filled' | 'complete' | 'several' | 'notFound' | 'error';
  id?: string | null;
  filled?: DetailField[] | null;
  error?: string | null;
  /** The set's release date found with the match (absent on lookups from before release dates). */
  released?: string | null;
  checkedAt: string;
}

/** "Pokémon", "N's", "V Star" → "pokemon", "ns", "vstar": compares names however they're written. */
const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
/** The card's own number without leading zeros: "051" → "51", "51/162" → "51", "SWSH298" → "swsh298". */
const ownNumber = (s: unknown) => {
  const n = String(s ?? '').split('/')[0].replace(/\s+/g, '').toLowerCase();
  return /^\d+$/.test(n) ? String(Number(n)) : n;
};
/** The set size after the slash, if the person typed one: "51/162" → 162. */
const setSize = (s: unknown) => {
  const m = /\/\s*(\d+)\s*$/.exec(String(s ?? ''));
  return m ? Number(m[1]) : null;
};
/** "Sleep! (Rocket's Secret Machine)" → "Sleep!": what the card itself is called. */
const withoutBrackets = (name: string) => name.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
/** TCGdex's search doesn't ignore accents, so these are searched as printed on the card. */
const ACCENTED: Record<string, string> = { pokemon: 'Pokémon', pokedex: 'Pokédex', flabebe: 'Flabébé' };
/**
 * The word to search TCGdex by: the longest word of the name, which avoids its punctuation
 * ("N's", "Hole-Digging"), and not "Pokémon" when there's another word ("Pokémon Center Lady").
 */
const searchWord = (name: string) => {
  const words = withoutBrackets(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(ex|gx|v|vmax|vstar|star|mega|lv|x)$/i.test(w));
  const pick = (words.length > 1 ? words.filter((w) => !/^pokemon$/i.test(w)) : words).reduce((a, b) => (b.length >= a.length ? b : a), '');
  return ACCENTED[pick.toLowerCase()] ?? pick;
};

/** TCGdex rarities in the ledger's own words. */
const RARITIES: Record<string, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  'rare holo': 'Holo Rare',
  'holo rare': 'Holo Rare',
  'double rare': 'Double Rare',
  'ultra rare': 'Ultra Rare',
  'holo rare v': 'Ultra Rare',
  'holo rare vmax': 'Ultra Rare',
  'holo rare vstar': 'Ultra Rare',
  'rare holo v': 'Ultra Rare',
  'rare holo vmax': 'Ultra Rare',
  'rare holo vstar': 'Ultra Rare',
  'rare holo ex': 'Ultra Rare',
  'rare holo gx': 'Ultra Rare',
  'illustration rare': 'Illustration Rare',
  'special illustration rare': 'Special Illustration Rare',
  'hyper rare': 'Hyper Rare',
  'mega hyper rare': 'Mega Hyper Rare',
  'ace spec rare': 'ACE SPEC Rare',
  'shiny rare': 'Shiny Rare',
  'shiny ultra rare': 'Shiny Rare',
  'secret rare': 'Secret Rare',
  promo: 'Promo',
};
export function mapRarity(r: unknown): string | null {
  const s = String(r ?? '').trim();
  if (!s || /^none$/i.test(s)) return null;
  return RARITIES[s.toLowerCase()] ?? s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const isBlank = (v: unknown) => v == null || String(v).trim() === '';
const englishOrUnset = (lang: unknown) => isBlank(lang) || /^en/i.test(String(lang));
/** Cards already looked up are tried again after this long, in case TCGdex has added them. */
const RECHECK_MS = 7 * 86_400_000;

interface Brief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}
interface FullCard extends Brief {
  rarity?: string;
  illustrator?: string;
  set: { id: string; name: string; cardCount?: { official?: number } };
}
interface SetInfo {
  id: string;
  name: string;
  abbreviation?: { official?: string };
  tcgOnline?: string;
  releaseDate?: string;
}

/** "2026-03-27" or "1999/01/09" → "1999-01-09"; anything else → null. */
const isoDate = (s: unknown) => {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(String(s ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export interface CardDetailsOptions {
  fetcher?: Fetcher;
  now?: () => Date;
}

export class CardDetails {
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(o: CardDetailsOptions = {}) {
    this.fetcher = o.fetcher ?? fetch;
    this.now = o.now ?? (() => new Date());
  }

  /** GET a TCGdex path as JSON, remembered for an hour (sets for a day) so typing doesn't repeat requests. */
  private json<T>(path: string): Promise<T> {
    const ttl = path.startsWith('/sets/') ? 86_400_000 : 3_600_000;
    const hit = this.cache.get(path);
    if (hit && this.now().getTime() - hit.at < ttl) return hit.value as Promise<T>;
    const value = get(this.fetcher, API + path, { headers: { Accept: 'application/json' } }).then((r) => r.json() as Promise<T>);
    value.catch(() => this.cache.delete(path));
    this.cache.set(path, { at: this.now().getTime(), value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  /**
   * The cards with this name and number, narrowed by the set size ("51/162") and by whatever set
   * or set code the person already typed. Several matches mean the person should choose.
   */
  async lookup(name: string, number: string, hints: { set?: string | null; setCode?: string | null } = {}): Promise<DetailsMatch[]> {
    const word = searchWord(name ?? '');
    const own = ownNumber(number);
    if (!word || !own) return [];
    const names = new Set([norm(name), norm(withoutBrackets(name))]);
    const find = (list: Brief[]) => (Array.isArray(list) ? list : []).filter((c) => names.has(norm(c.name)) && ownNumber(c.localId) === own).slice(0, 12);
    let hits = find(await this.json<Brief[]>(`/cards?name=${encodeURIComponent(word)}`));
    // Not found by name (an unusual spelling or accent): every card with that number, then the name.
    if (!hits.length) hits = find(await this.json<Brief[]>(`/cards?localId=${encodeURIComponent(own)}`));
    let matches = await Promise.all(hits.map((h) => this.match(h.id)));
    const narrow = (keep: (m: DetailsMatch) => boolean) => {
      const n = matches.filter(keep);
      if (n.length) matches = n;
    };
    const size = setSize(number);
    if (size != null) narrow((m) => m.total === size);
    if (!isBlank(hints.setCode)) narrow((m) => norm(m.setCode) === norm(hints.setCode));
    if (!isBlank(hints.set)) narrow((m) => norm(m.set).includes(norm(hints.set).replace(/^pokemon/, '')) || norm(hints.set).includes(norm(m.set)));
    return matches.slice(0, 8);
  }

  private async match(id: string): Promise<DetailsMatch> {
    const c = await this.json<FullCard>(`/cards/${encodeURIComponent(id)}`);
    const s = await this.json<SetInfo>(`/sets/${encodeURIComponent(c.set.id)}`).catch(() => null);
    const total = c.set.cardCount?.official;
    return {
      id: c.id,
      name: c.name,
      number: c.localId,
      set: c.set.name,
      setCode: s?.abbreviation?.official ?? s?.tcgOnline ?? null,
      total: total ? total : null,
      rarity: mapRarity(c.rarity),
      artist: c.illustrator?.trim() || null,
      released: isoDate(s?.releaseDate),
      thumb: c.image ? `${c.image}/low.webp` : null,
    };
  }

  /**
   * When a card came out. A promo set's date is when that promo series began (SWSH Black Star
   * Promos: 2019), so a promo filed under a set by name ("Crown Zenith") takes that set's date.
   */
  private async releasedFor(m: DetailsMatch, filedUnder: unknown): Promise<string | null> {
    if (!/promo/i.test(m.set) || isBlank(filedUnder)) return m.released;
    const name = String(filedUnder).replace(/^\s*pok[eé]mon\s+/i, '').trim();
    if (!name || norm(name) === norm(m.set)) return m.released;
    const sets = await this.json<{ id: string; name: string }[]>(`/sets?name=${encodeURIComponent(name)}`).catch(() => []);
    const hit = (Array.isArray(sets) ? sets : []).find((x) => norm(x.name) === norm(name));
    if (!hit) return m.released;
    const info = await this.json<SetInfo>(`/sets/${encodeURIComponent(hit.id)}`).catch(() => null);
    return isoDate(info?.releaseDate) ?? m.released;
  }

  /** The fields of `card` that are empty and that `m` knows. */
  static patchFor(card: Doc, m: DetailsMatch): { patch: Doc; filled: DetailField[] } {
    const values: Record<DetailField, string | null> = { set: m.set, setCode: m.setCode, rarity: m.rarity, artist: m.artist, released: m.released };
    const patch: Doc = {};
    const filled: DetailField[] = [];
    for (const f of DETAIL_FIELDS) {
      if (isBlank(card[f]) && !isBlank(values[f])) {
        patch[f] = values[f];
        filled.push(f);
      }
    }
    return { patch, filled };
  }

  /**
   * Whether a card has blanks this could fill and hasn't been looked up recently. A card matched
   * before release dates were kept is wanted straight away: its release date is one quick fetch.
   */
  wants(card: Doc | undefined, force = false): boolean {
    if (!card || isBlank(card.name) || isBlank(card.number) || !englishOrUnset(card.language)) return false;
    if (!DETAIL_FIELDS.some((f) => isBlank(card[f]))) return false;
    const last = card.details as DetailsStatus | undefined;
    if (force || !last?.checkedAt || CardDetails.lacksReleaseDate(card)) return true;
    return this.now().getTime() - Date.parse(last.checkedAt) > RECHECK_MS;
  }

  /** A card matched to one TCGdex card before release dates were kept, still without one. */
  static lacksReleaseDate(card: Doc): boolean {
    const last = card.details as DetailsStatus | null | undefined;
    return !!last?.id && !('released' in last) && isBlank(card.released);
  }

  /**
   * Fill a stored card's empty details when exactly one card matches, and record what happened
   * on the card. A card already matched is fetched by its TCGdex id instead of searched again
   * (a card that becomes a different one has its match cleared first, see autofill.ts).
   * Re-reads the card before writing so nothing typed meanwhile is lost.
   */
  async fill(store: Store, id: string, force = false): Promise<DetailsStatus['result'] | 'skipped'> {
    const card = store.get('cards', id);
    if (!this.wants(card, force)) return 'skipped';
    const checkedAt = this.now().toISOString();
    let status: DetailsStatus;
    let patch: Doc = {};
    try {
      const known = (card!.details as DetailsStatus | null | undefined)?.id;
      const found = known
        ? [await this.match(known)]
        : await this.lookup(String(card!.name), String(card!.number), { set: card!.set as string, setCode: card!.setCode as string });
      if (found.length === 1) {
        const m = { ...found[0], released: await this.releasedFor(found[0], store.get('cards', id)?.set) };
        const fresh = store.get('cards', id);
        if (!fresh) return 'skipped';
        const p = CardDetails.patchFor(fresh, m);
        patch = p.patch;
        status = { source: 'tcgdex', result: p.filled.length ? 'filled' : 'complete', id: m.id, filled: p.filled, released: m.released, checkedAt };
      } else status = { source: 'tcgdex', result: found.length ? 'several' : 'notFound', checkedAt };
    } catch (err) {
      status = { source: 'tcgdex', result: 'error', error: err instanceof SourceError || err instanceof Error ? err.message.slice(0, 300) : String(err), checkedAt };
    }
    if (!store.get('cards', id)) return 'skipped';
    store.update('cards', id, { ...patch, details: status });
    return status.result;
  }
}
