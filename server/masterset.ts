// A master set: every English card of one Pokémon ever released, in every variant (regular,
// holo, reverse holo, 1st Edition, Shadowless, Poké Ball and Master Ball patterns, stamps), from
// TCGdex (https://tcgdex.dev). The page previews it, then creates a binder holding one
// placeholder per variant, owned by whoever is collecting it, to switch to Owned as the cards are
// bought. Placeholders are priced and pictured like any other card (autofill.ts picks them up).

import { type CardDetails, ACCENTED, DETAILS_VERSION, type DetailsStatus, isoDate, mapRarity } from './details';
import { type TcgdexCard, type TcgdexVariant, chooseVariant, featuresOf } from './pricing/catalog';
import type { Doc } from './schema';

/** One placeholder of a master set: a card in one of its variants. */
export interface MasterSetCard {
  /** TCGdex card id, e.g. "base1-27". */
  tcgdexId: string;
  name: string;
  set: string;
  setId: string;
  setCode: string | null;
  /** As printed: "27/102", "083/165", "SWSH020". */
  number: string;
  rarity: string | null;
  /** Blank for the card itself; otherwise what sets this printing apart ("Reverse Holo", "1st Edition Shadowless"). */
  variant: string;
  artist: string | null;
  released: string | null;
  thumb: string | null;
}

export interface MasterSet {
  /** The Pokémon as TCGdex names it ("Farfetch'd"). */
  pokemon: string;
  /** Its National Pokédex number, when TCGdex knows it. */
  dexId: number | null;
  /** How many different cards (each in one or more variants). */
  cards: number;
  /** One per variant, oldest set first. */
  entries: MasterSetCard[];
}

interface Brief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}
interface FullCard extends TcgdexCard {
  category?: string;
  rarity?: string;
  illustrator?: string;
  dexId?: number[];
  variants?: { normal?: boolean; reverse?: boolean; holo?: boolean; firstEdition?: boolean } | null;
  variants_detailed?: (TcgdexVariant & { size?: string })[] | null;
}
interface SetInfo {
  id: string;
  name: string;
  abbreviation?: { official?: string };
  tcgOnline?: string;
  releaseDate?: string;
}

/** A name's words, without accents or punctuation: "Farfetch’d" → ["farfetch", "d"], "Mr. Mime" → ["mr", "mime"]. */
export const words = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether a card's name is a card of this Pokémon: its words appear in order, whole ("Ash's
 * Pikachu", "Pikachu VMAX", "Pikachu & Zekrom GX" for Pikachu; not "Mewtwo" for Mew, nor "Mime Jr."
 * for Mr. Mime).
 */
export function namesPokemon(cardName: unknown, pokemon: unknown): boolean {
  const c = words(cardName), p = words(pokemon);
  if (!p.length) return false;
  for (let i = 0; i + p.length <= c.length; i++) if (p.every((w, j) => c[i + j] === w)) return true;
  return false;
}

/** The word to search TCGdex by: the longest, as TCGdex spells it ("Farfetch'd" → "Farfetch", "Flabebe" → "Flabébé"). */
const searchWord = (pokemon: string) => {
  const w = words(pokemon).reduce((a, b) => (b.length > a.length ? b : a), '');
  return ACCENTED[w] ?? w;
};

/** TCGdex's feature words as printed on the cards. */
const SPELLED: Record<string, string> = { pokeball: 'Poké Ball', masterball: 'Master Ball', pokemon: 'Pokémon', mcdonalds: "McDonald's", wotc: 'WotC', poketour: 'PokéTour' };
/** "Poké Ball", "1st Edition", "1999-2000 Copyright", "Pokémon Day": a TCGdex variant feature in words. */
const featureWords = (f: string) =>
  SPELLED[f] ??
  f
    .split(/(?<=\D)-|-(?=\D)/)
    .map((w) => SPELLED[w] ?? (/^\d+st$/.test(w) ? w : w.replace(/^[a-z]/, (c) => c.toUpperCase())))
    .join(' ');
const KIND_WORDS: Record<string, string> = { holo: 'Holo', reverse: 'Reverse Holo' };

/**
 * The Variant text for one of a card's variants: the shortest that the daily price update reads
 * back as that same variant (catalog.ts chooseVariant), so each placeholder is priced as its own
 * printing. Blank for the card itself, "Reverse Holo", "1st Edition Shadowless", "Master Ball Reverse Holo".
 */
export function variantText(card: TcgdexCard, v: TcgdexVariant): string {
  const kind = KIND_WORDS[v.type] ?? '';
  const full = [...featuresOf(v).map(featureWords), kind].filter(Boolean).join(' ');
  for (const text of ['', kind, full]) if (chooseVariant(card, text).variant === v) return text;
  return full;
}

/**
 * A card's variants: TCGdex's detailed list (standard-size cards only, not jumbo ones), or, for a
 * card without one, its simple flags (regular, holo, reverse, 1st Edition of each).
 */
function variantsOf(c: FullCard): TcgdexVariant[] {
  const detailed = (c.variants_detailed ?? []).filter((v) => v && typeof v.type === 'string' && (!v.size || v.size === 'standard'));
  if (detailed.length) return detailed;
  const f = c.variants ?? {};
  const kinds = (['normal', 'holo', 'reverse'] as const).filter((k) => f[k]);
  const list: TcgdexVariant[] = kinds.map((type) => ({ type }));
  if (f.firstEdition) for (const type of kinds.filter((k) => k !== 'reverse')) list.push({ type, stamp: ['1st-edition'] });
  return list.length ? list : [{ type: 'normal' }];
}

/** "27" of 102 → "27/102", "083" of 165 → "083/165"; promos and sub-set numbers ("SWSH020", "TG05") as they are. */
const printedNumber = (localId: string, official: number | undefined) => (official && /^\d+$/.test(localId) ? `${localId}/${String(official).padStart(localId.length, '0')}` : localId);

/** Card numbers in order: 2 before 10, numbers before letters. */
const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** Runs `fn` over `items`, `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return out;
}

export class MasterSets {
  constructor(private readonly details: CardDetails) {}

  /**
   * Every English card of the Pokémon, in every variant, oldest set first. Cards are found by
   * name (whole words: its trainer's, ex, V and GX cards too) and by Pokédex number (cards named
   * otherwise); TCG Pocket's digital cards and anything that isn't a Pokémon card are left out.
   */
  async find(pokemon: string): Promise<MasterSet> {
    const word = searchWord(pokemon);
    if (!word) return { pokemon: pokemon.trim(), dexId: null, cards: 0, entries: [] };
    const db = this.details;
    const isPocket = await db.pocketTest();
    const setOf = (c: Brief) => (c.id.endsWith(`-${c.localId}`) ? c.id.slice(0, -c.localId.length - 1) : c.id.replace(/-[^-]+$/, ''));
    const list = (x: unknown) => (Array.isArray(x) ? (x as Brief[]) : []);
    const byName = list(await db.json(`/cards?name=${encodeURIComponent(word)}`)).filter((c) => namesPokemon(c.name, pokemon));
    // Its Pokédex number, from a card named just that, finds the cards named otherwise.
    const exact = byName.find((c) => words(c.name).join(' ') === words(pokemon).join(' '));
    const named = exact ? await db.json<FullCard>(`/cards/${encodeURIComponent(exact.id)}`).catch(() => null) : null;
    const dexId = named?.dexId?.length === 1 ? named.dexId[0] : null;
    const byDex = dexId != null ? list(await db.json(`/cards?dexId=eq:${dexId}`)) : [];
    const briefs = [...new Map([...byName, ...byDex].map((c) => [c.id, c])).values()].filter((c) => !isPocket(setOf(c)));

    const full = (await pool(briefs, 6, (b) => db.json<FullCard>(`/cards/${encodeURIComponent(b.id)}`))).filter((c) => !c.category || c.category === 'Pokemon');
    const setIds = [...new Set(full.map((c) => c.set.id))];
    const sets = new Map((await pool(setIds, 6, (id) => db.json<SetInfo>(`/sets/${encodeURIComponent(id)}`).catch(() => null))).map((s, i) => [setIds[i], s]));

    const entries: (MasterSetCard & { order: number })[] = [];
    for (const c of full) {
      const s = sets.get(c.set.id);
      const vs = variantsOf(c);
      const card: TcgdexCard = { ...c, variants_detailed: vs };
      const seen = new Set<string>();
      vs.forEach((v, order) => {
        const variant = variantText(card, v);
        if (seen.has(variant)) return;
        seen.add(variant);
        entries.push({
          tcgdexId: c.id,
          name: c.name,
          set: c.set.name,
          setId: c.set.id,
          setCode: s?.abbreviation?.official ?? s?.tcgOnline ?? null,
          number: printedNumber(c.localId, c.set.cardCount?.official),
          rarity: mapRarity(c.rarity),
          variant,
          artist: c.illustrator?.trim() || null,
          released: isoDate(s?.releaseDate),
          thumb: c.image ? `${c.image}/low.webp` : null,
          order,
        });
      });
    }
    entries.sort((a, b) => (a.released ?? '9999').localeCompare(b.released ?? '9999') || a.setId.localeCompare(b.setId) || byNumber(a.number, b.number) || a.order - b.order);
    return {
      pokemon: named?.name ?? exact?.name ?? pokemon.trim(),
      dexId,
      cards: full.length,
      entries: entries.map(({ order: _order, ...e }) => e),
    };
  }
}

/**
 * The placeholder cards for a master set's binder, filling its pages from page 1, pocket 1. Each
 * is matched to its TCGdex card already (as if the person chose it), so lookups and prices go
 * straight to it.
 */
export function placeholderCards(entries: MasterSetCard[], o: { binderId: string; pockets: number; owner: string; now: string }): Doc[] {
  return entries.map((e, i) => {
    const details: DetailsStatus = {
      source: 'tcgdex',
      result: 'complete',
      v: DETAILS_VERSION,
      id: e.tcgdexId,
      filled: [],
      setId: e.setId,
      set: e.set,
      setCode: e.setCode,
      released: e.released,
      chosen: true,
      checkedAt: o.now,
    };
    return {
      name: e.name,
      set: e.set,
      setCode: e.setCode ?? '',
      number: e.number,
      rarity: e.rarity ?? '',
      variant: e.variant,
      language: 'English',
      condition: 'Near Mint',
      grader: 'Raw',
      grade: '',
      artist: e.artist ?? '',
      notes: '',
      status: 'binder',
      owner: o.owner,
      placeholder: true,
      prices: [],
      imageId: null,
      binderId: o.binderId,
      page: Math.floor(i / o.pockets) + 1,
      slot: (i % o.pockets) + 1,
      released: e.released,
      details,
      createdAt: o.now,
      updatedAt: o.now,
    };
  });
}
