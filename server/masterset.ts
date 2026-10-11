// A master set: every card of one set (151, Ascended Heroes), its sub-sets included, in every
// variant (regular, holo, reverse holo, 1st Edition, Shadowless, Poké Ball and Master Ball
// patterns), from TCGdex (https://tcgdex.dev), checked against TCGplayer's own catalog (tcgcsv.ts):
// a printing TCGplayer lists that TCGdex doesn't (Hidden Fates' reverse holos) is added from it. The
// page previews it, then creates a binder holding one placeholder per variant, owned by whoever is
// collecting it, to switch to Owned as the cards are bought. Placeholders are priced and pictured
// like any other card (autofill.ts picks them up).
//
// Only whole sets: a Pokémon's cards across every set were tried and dropped, as TCGdex misses too
// many of a Pokémon's promo and special printings.

import { type CardDetails, DETAILS_VERSION, type DetailsStatus, isSubSet, isoDate, mapRarity, similarity } from './details';
import { type TcgdexCard, type TcgdexVariant, chooseVariant, featuresOf } from './pricing/catalog';
import { SourceError, tcgImage } from './pricing/sources';
import { type TcgCsv, type TcgGroup, type TcgPrice, type TcgProduct, ownNumber, productName, setName } from './pricing/tcgcsv';
import type { Doc } from './schema';

/** One placeholder of a master set: a card in one of its variants. */
export interface MasterSetCard {
  /** TCGdex card id, e.g. "base1-27"; null for a card only TCGplayer lists. */
  tcgdexId: string | null;
  /** TCGplayer's product, for a printing only TCGplayer lists: the placeholder is matched to it. */
  tcgplayerId: string | null;
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
  /** A promo printing of the card (a store or event stamp, a Cosmos holo from a blister, a metal card), left out of a set's master set unless asked for. */
  extra: boolean;
}

export interface MasterSet {
  /** The set as TCGdex names it ("151"). */
  title: string;
  /** The set's TCGdex id ("sv03.5"). */
  setId: string;
  /** How many different cards (each in one or more variants). */
  cards: number;
  /** One per variant, in card-number order, its sub-sets after it. */
  entries: MasterSetCard[];
  /** Checked against TCGplayer's catalog: how many printings it added, or why it couldn't be checked. */
  tcgplayer: { checked: true; added: number; sets: string[] } | { checked: false; error: string };
}

/** A set to offer when choosing one: TCGdex's English sets, TCG Pocket's left out. */
export interface SetChoice {
  id: string;
  name: string;
  /** Cards in it, secret rares included. */
  total: number | null;
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

/** TCGdex's feature words as printed on the cards. */
const SPELLED: Record<string, string> = { pokeball: 'Poké Ball', masterball: 'Master Ball', pokemon: 'Pokémon', mcdonalds: "McDonald's", wotc: 'WotC', poketour: 'PokéTour' };
/** "Ascended Heroes", "Scarlet & Violet—151" → "ascendedheroes", "scarletviolet151": compares set names however they're written. */
const norm = (s: unknown) => words(s).join('');

/** Sub-sets named after their set, released with it, whose TCGdex ids aren't the set's ("Hidden Fates Shiny Vault", sma). */
const SUBSET_NAMES = /^(shiny vault|trainer gallery|galarian gallery|classic collection|radiant collection|unown collection)$/i;
/** A set name ending in a sub-set's ("Generations: Radiant Collection"). */
const SUBSET_ENDING = /(shiny vault|trainer gallery|galarian gallery|classic collection|radiant collection|unown collection)$/i;
/** A sub-set of `set`: by TCGdex's id (swsh11tg for swsh11) or by name (Hidden Fates Shiny Vault for Hidden Fates). */
const subSetOf = (set: SetChoice, x: SetChoice) => x.id !== set.id && (isSubSet(set.id, x.id) || (x.name.startsWith(`${set.name} `) && SUBSET_NAMES.test(x.name.slice(set.name.length + 1))));

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

/** Patterns a set's own reverse holos come in (Poké Ball, Master Ball, Energy symbol, Team Rocket): part of the set, not promos. */
const isPattern = (foil: string) => /ball$/.test(foil) || foil === 'energy' || foil === 'team-rocket';

/**
 * Whether a variant is a promo printing rather than one of the set's own: a stamp (other than 1st
 * Edition: GameStop, Pokémon Center, set logo, Player Rewards…), something other than a regular,
 * holo or reverse holo card (a metal card), or a foil (Cosmos, Galaxy, a second gold) on a card that
 * also comes plain (a Cosmos holo Charmander from a blister). A finish that is the card itself (a gold Hyper Rare listed only
 * gold, Fossil's galaxy holos) isn't.
 */
export function isExtra(v: TcgdexVariant, all: TcgdexVariant[]): boolean {
  // The EX era's reverse holos carry the set's logo: when there's no other reverse holo, that's the set's own.
  const ownReverse = v.type === 'reverse' && (v.stamp ?? []).every((x) => x === 'set-logo') && !all.some((o) => o !== v && o.type === 'reverse');
  if (!ownReverse && (v.stamp ?? []).some((x) => x !== '1st-edition')) return true;
  if (!['normal', 'holo', 'reverse'].includes(v.type)) return true;
  return !!v.foil && !isPattern(v.foil) && all.some((o) => o !== v && !featuresOf(o).length);
}

/** A TCGplayer product's bracket that names a promo printing, not one of the set's own. */
const PROMO_WORDS = /stamp|prerelease|staff|exclusive|cosmos|promo|league|championship|winner|gamestop|eb games|pokemon center|best buy|walmart|target/i;

/**
 * A TCGplayer printing as a Variant: its bracket ("Poke Ball Pattern") and its kind of printing
 * ("Reverse Holofoil" → Reverse Holo, "1st Edition Holofoil" → 1st Edition Holo).
 */
export function tcgVariant(bracket: string, subType: string): string {
  if (/^(reverse holo(foil)?|holo(foil)?|normal|non-holo)$/i.test(bracket.trim())) bracket = '';
  const first = /1st/i.test(subType) ? '1st Edition' : '';
  const kind = /reverse/i.test(subType) ? 'Reverse Holo' : /holo|foil/i.test(subType) ? 'Holo' : '';
  return [first, bracket, bracket && kind === 'Holo' ? '' : kind].filter(Boolean).join(' ');
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
  constructor(
    private readonly details: CardDetails,
    private readonly tcgcsv?: TcgCsv,
  ) {}

  /** TCGdex's English sets, newest last, without TCG Pocket's or its jumbo cards (oversized promos, not a set). */
  async sets(): Promise<SetChoice[]> {
    const isPocket = await this.details.pocketTest();
    const all = await this.details.json<{ id: string; name: string; cardCount?: { total?: number } }[]>('/sets');
    return (Array.isArray(all) ? all : []).filter((x) => !isPocket(x.id) && x.id !== 'jumbo').map((x) => ({ id: x.id, name: x.name, total: x.cardCount?.total || null }));
  }

  /**
   * Every card of a set, named as TCGdex names it ("151", "Ascended Heroes") or by its id
   * ("sv03.5"), in every variant: trainers and energy too, secret rares, and its reprint sub-sets
   * (Trainer Gallery, Galarian Gallery, Shiny Vault, Classic Collection) after its own cards, then
   * checked against TCGplayer's catalog. Null when no set has that name.
   */
  async findSet(query: string): Promise<MasterSet | null> {
    const sets = await this.sets();
    const q = norm(query);
    const set = sets.find((x) => norm(x.name) === q) ?? sets.find((x) => x.id.toLowerCase() === query.trim().toLowerCase()) ?? null;
    if (!q || !set) return null;
    const family = [set, ...sets.filter((x) => subSetOf(set, x))];
    const db = this.details;
    const briefs: Brief[] = [];
    for (const x of family) {
      const full = await db.json<{ cards?: Brief[] }>(`/sets/${encodeURIComponent(x.id)}`);
      briefs.push(...(Array.isArray(full?.cards) ? full.cards : []));
    }
    const full = await pool(briefs, 6, (b) => db.json<FullCard>(`/cards/${encodeURIComponent(b.id)}`));
    const infos = new Map((await pool(family, 6, (x) => db.json<SetInfo>(`/sets/${encodeURIComponent(x.id)}`).catch(() => null))).map((s, i) => [family[i].id, s]));
    const entries = this.entriesOf(full, infos);
    const tcgplayer = await this.fromTcgplayer(family, infos, full, entries);
    const order = family.map((x) => x.id);
    entries.sort((a, b) => order.indexOf(a.setId) - order.indexOf(b.setId) || byNumber(a.number, b.number) || a.order - b.order);
    return { title: set.name, setId: set.id, cards: new Set(entries.map((e) => `${e.setId}|${ownNumber(e.number)}`)).size, entries: entries.map(({ order: _order, ...e }) => e), tcgplayer };
  }

  /** One entry per variant of each card. */
  private entriesOf(full: FullCard[], sets: Map<string, SetInfo | null>): (MasterSetCard & { order: number })[] {
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
          tcgplayerId: null,
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
          extra: isExtra(v, vs),
          order,
        });
      });
    }
    return entries;
  }

  /**
   * Checks the set against TCGplayer's catalog, set by set: where TCGplayer lists more printings of
   * a card than TCGdex (or a card TCGdex doesn't have), the printings TCGdex has no variant for are
   * added to `entries`, matched to their TCGplayer product.
   */
  private async fromTcgplayer(family: SetChoice[], infos: Map<string, SetInfo | null>, full: FullCard[], entries: (MasterSetCard & { order: number })[]): Promise<MasterSet['tcgplayer']> {
    if (!this.tcgcsv) return { checked: false, error: "TCGplayer's catalog isn't used on this server." };
    // Someone asked for it now: try tcgcsv.com even if a price update found it failing.
    this.tcgcsv.reset();
    let groups: TcgGroup[];
    try {
      groups = await this.tcgcsv.groupList();
    } catch (err) {
      return { checked: false, error: `TCGplayer's catalog (tcgcsv.com) didn't answer: ${err instanceof Error ? err.message : err}` };
    }
    // Each TCGdex set's TCGplayer set, and TCGplayer's sub-sets that TCGdex keeps in the set itself
    // (Generations' Radiant Collection: RC1… on TCGdex, "Generations: Radiant Collection" on TCGplayer).
    const pairs: { x: SetChoice; g: TcgGroup }[] = [];
    for (const x of family) {
      const g = groupOf(groups, x.id, x.name);
      if (g) pairs.push({ x, g });
    }
    for (const g of subGroupsOf(groups, family[0].name)) if (!pairs.some((p) => p.g.groupId === g.groupId)) pairs.push({ x: family[0], g });
    // A TCGdex sub-set TCGplayer keeps in the set itself (Unseen Forces' Unown Collection) is matched with it.
    const own = (x: SetChoice) => full.filter((c) => c.set.id === x.id || (x === family[0] && !pairs.some((p) => p.x.id === c.set.id)));
    const named: string[] = [];
    let added = 0;
    for (const { x, g } of pairs) {
      let data: { products: TcgProduct[]; prices: TcgPrice[] };
      try {
        data = await this.tcgcsv.group(g.groupId);
      } catch (err) {
        if (err instanceof SourceError) return { checked: false, error: `TCGplayer's catalog (tcgcsv.com) didn't answer: ${err.message}` };
        throw err;
      }
      named.push(g.name);
      const mineOf = own(x);
      const byNumber = new Map(mineOf.map((c) => [ownNumber(c.localId), c]));
      // TCGplayer's product as one of TCGdex's cards: the same number and a similar name ("Umbreon
      // Star" for "Umbreon ☆"); else the card with that name or a similar one that no TCGplayer
      // product has by its number (a sub-set numbered its own way: Celebrations' Classic Collection
      // is CC004 on TCGdex, 4/102 on TCGplayer), cards with the same name (a LEGEND's two halves)
      // paired one each; else the card with that number, spelt otherwise ("Blend Energy GFPD"),
      // unless another product is that card. None: a card TCGdex doesn't list (Shrouded Fable's
      // reverse holo Energies 3/064 and 8/064, numbered like its Rowlet and Houndoom).
      const similar = (c: FullCard, base: string) => {
        const a = norm(c.name), b = norm(base);
        return a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) || similarity(c.name, base) >= 0.75;
      };
      const numbered = (p: TcgProduct) => {
        const c = byNumber.get(ownNumber(p.extendedData?.find((e) => e.name === 'Number')?.value));
        return c && similar(c, productName(p.name).base) ? c : undefined;
      };
      const claimed = new Set(data.products.map(numbered).filter((c): c is FullCard => !!c).map((c) => c.id));
      const taken = new Set(claimed);
      const cardOf = (p: TcgProduct) => {
        const c = numbered(p);
        if (c) return c;
        const byNum = byNumber.get(ownNumber(p.extendedData?.find((e) => e.name === 'Number')?.value));
        const base = productName(p.name).base;
        const free = mineOf.filter((o) => !taken.has(o.id));
        const exact = free.filter((o) => norm(o.name) === norm(base));
        const near = exact.length ? exact : free.filter((o) => similar(o, base));
        if (near.length === 1) return near[0];
        const pick = exact.find((o) => !taken.has(o.id));
        if (pick) taken.add(pick.id);
        return pick ?? (byNum && !claimed.has(byNum.id) ? byNum : undefined);
      };
      // TCGplayer's printings of each card: its products (a Poké Ball pattern is a product of its own) by printing.
      const printings = new Map<string, { card: FullCard | undefined; list: { p: TcgProduct; variant: string; bracket: string }[] }>();
      for (const p of data.products) {
        if (!p.extendedData?.some((e) => e.name === 'Number') || /jumbo|oversize/i.test(p.name)) continue;
        const card = cardOf(p);
        const key = card ? card.id : `tcgplayer:${p.productId}`;
        const { variant: bracket } = productName(p.name);
        const types = [...new Set(data.prices.filter((r) => r.productId === p.productId).map((r) => r.subTypeName))];
        const at = printings.get(key) ?? { card, list: [] };
        for (const t of types.length ? types : ['Normal']) at.list.push({ p, variant: tcgVariant(bracket, t), bracket });
        printings.set(key, at);
      }
      for (const { card, list } of printings.values()) {
        const mine = card ? entries.filter((e) => e.tcgdexId === card.id) : [];
        if (list.length <= mine.length) continue;
        const tcgCard: TcgdexCard | null = card ? { ...card, variants_detailed: variantsOf(card) } : null;
        // Each of TCGplayer's printings takes the TCGdex variant it names, else a free one of the same
        // kind (TCGdex's set-logo reverse holo for TCGplayer's "Reverse Holofoil"); patterns and holo
        // and reverse printings first, so a plain "Normal" listed for a holo rare doesn't take its holo.
        const claimed = new Set<TcgdexVariant>();
        const kindOf = (variant: string) => (/reverse/i.test(variant) ? 'reverse' : /holo/i.test(variant) ? 'holo' : 'normal');
        const rank = (m: { variant: string; bracket: string }) => (m.bracket ? 0 : m.variant ? 1 : 2);
        const missing = [...list].sort((a, b) => rank(a) - rank(b)).filter(({ variant, bracket }) => {
          if (!tcgCard) return true;
          const named = chooseVariant(tcgCard, variant).variant;
          const v = named && !claimed.has(named) ? named : bracket ? null : (tcgCard.variants_detailed ?? []).find((o) => !claimed.has(o) && o.type === kindOf(variant));
          if (v) return claimed.add(v), false;
          return true;
        });
        for (const m of missing.slice(0, list.length - mine.length)) {
          const number = m.p.extendedData?.find((e) => e.name === 'Number')?.value ?? '';
          // A plain printing TCGplayer lists of a card TCGdex only has as a holo is named so, not read as the holo.
          const variant = m.variant === '' && tcgCard && chooseVariant(tcgCard, '').variant ? 'Non-Holo' : m.variant;
          const at = card ? (family.find((f) => f.id === card.set.id) ?? x) : x;
          const info = infos.get(at.id);
          entries.push({
            tcgdexId: card?.id ?? null,
            tcgplayerId: String(m.p.productId),
            name: card?.name ?? productName(m.p.name).base,
            set: at.name,
            setId: at.id,
            setCode: info?.abbreviation?.official ?? info?.tcgOnline ?? null,
            number: card ? printedNumber(card.localId, card.set.cardCount?.official) : number,
            rarity: card ? mapRarity(card.rarity) : mapRarity(m.p.extendedData?.find((e) => e.name === 'Rarity')?.value),
            variant,
            artist: card?.illustrator?.trim() || null,
            released: isoDate(info?.releaseDate),
            thumb: tcgImage(m.p.productId, 200),
            extra: PROMO_WORDS.test(m.bracket),
            order: 100 + added,
          });
          added++;
        }
      }
    }
    return named.length ? { checked: true, added, sets: named } : { checked: false, error: `TCGplayer's catalog has no set called ${family[0].name}.` };
  }
}

/** TCGdex's sets that TCGplayer names otherwise, by TCGdex id. */
const TCGPLAYER_NAMES: Record<string, string> = {
  sm1: 'SM Base Set',
  basep: 'WoTC Promo',
  np: 'Nintendo Promos',
  dpp: 'Diamond and Pearl Promos',
  hgssp: 'HGSS Promos',
  bwp: 'Black and White Promos',
  xyp: 'XY Promos',
  smp: 'SM Promos',
  swshp: 'SWSH: Sword & Shield Promo Cards',
  svp: 'SV: Scarlet & Violet Promo Cards',
  mep: 'ME: Mega Evolution Promo',
  sve: 'SVE: Scarlet & Violet Energies',
  ru1: 'Rumble',
  '30th-c': 'ME: 30th Celebration Classic Collection',
  '2021swsh': "McDonald's 25th Anniversary Promos",
};
/** A set name however it's written: "&" or "and", with or without TCGplayer's series ("XY - Evolutions", "EX Ruby and Sapphire") and "Base Set". */
const setForms = (name: string, tcgplayer: boolean) => {
  const n = name.replace(/&/g, ' and ');
  const forms = [n, n.replace(/\s+Base Set$/i, '')];
  if (tcgplayer) forms.push(n.replace(/^[A-Za-z]+\s+-\s+/, ''), n.replace(/^EX\s+/, ''));
  else forms.push(n.replace(/Collection (\d{4})$/i, 'Promos $1'));
  return new Set(forms.map(norm).filter(Boolean));
};

/**
 * The TCGplayer set that is this TCGdex set: the one with its name, however it's written
 * ("Hidden Fates: Shiny Vault", "SWSH11: Lost Origin", "XY - Evolutions", "Black and White"), else
 * the one ending with it ("SV: Scarlet & Violet 151"). Null when there's none, or several.
 */
export function groupOf(groups: TcgGroup[], id: string, name: string): TcgGroup | null {
  const alias = TCGPLAYER_NAMES[id];
  if (alias) return groups.find((g) => g.name === alias) ?? null;
  const want = setForms(name, false);
  const exact = groups.filter((g) => [...setForms(setName(g), true), ...setForms(g.name, true)].some((f) => want.has(f)));
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const n = norm(name.replace(/&/g, ' and '));
  const ends = groups.filter((g) => n.length >= 3 && norm(setName(g).replace(/&/g, ' and ')).endsWith(n));
  return ends.length === 1 ? ends[0] : null;
}

/** TCGplayer's sub-sets of a set, named after it ("Generations: Radiant Collection" for Generations). */
export function subGroupsOf(groups: TcgGroup[], name: string): TcgGroup[] {
  const n = norm(name.replace(/&/g, ' and '));
  return groups.filter((g) => {
    const f = norm(setName(g).replace(/&/g, ' and '));
    return f !== n && f.startsWith(n) && SUBSET_ENDING.test(setName(g));
  });
}

/**
 * The placeholder cards for a master set's binder, filling its pages from page 1, pocket 1. Each
 * is matched to its TCGdex card already (as if the person chose it), and a printing only TCGplayer
 * lists to its TCGplayer product, so lookups and prices go straight to them.
 */
export function placeholderCards(entries: MasterSetCard[], o: { binderId: string; pockets: number; owner: string; now: string }): Doc[] {
  return entries.map((e, i) => {
    const details: DetailsStatus | null = !e.tcgdexId ? null : {
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
      ...(e.tcgplayerId
        ? { pricing: { source: 'tcgplayer', id: e.tcgplayerId, url: `https://www.tcgplayer.com/product/${e.tcgplayerId}`, title: e.variant ? `${e.name} [${e.variant}]` : e.name, set: e.set, linkedBy: 'auto', linkedAt: o.now } }
        : {}),
      createdAt: o.now,
      updatedAt: o.now,
    };
  });
}
