// TCGplayer's own catalog, from tcgcsv.com: a free public copy of TCGplayer's catalog API (sets,
// products and prices as JSON, no key), refreshed every day around 20:00 UTC. It's the fallback
// for what the card databases (catalog.ts) don't have: a card TCGdex has no TCGplayer price for
// (Lost Origin's Trainer Gallery Snorlax), a card TCGdex doesn't know at all, its picture, and its
// blank rarity and release date. Pokémon is category 3; each set is a "group" with its products
// (cards and sealed products) and their prices by printing ("Normal", "Holofoil", "Reverse
// Holofoil"…). The binder downloads the list of sets and only the sets its cards need, each at
// most once a day, a quarter second apart, and stops asking for the rest of an update after
// failing three times in a row.

import { chooseVariant, pickPrinting, printingOf, type Printing, type TcgdexCard } from './catalog';
import { mapRarity, similarity } from '../details';
import { type Fetcher, SourceError, get, releaseDate } from './sources';

const TCGCSV = 'https://tcgcsv.com/tcgplayer/3';

export interface TcgGroup {
  groupId: number;
  name: string;
  abbreviation?: string | null;
  publishedOn?: string | null;
}
export interface TcgProduct {
  productId: number;
  name: string;
  groupId: number;
  url?: string;
  imageUrl?: string;
  extendedData?: { name: string; value: string }[];
}
export interface TcgPrice {
  productId: number;
  marketPrice?: number | null;
  midPrice?: number | null;
  subTypeName: string;
}

/** What TCGplayer's catalog says about a card: its product, set, price for its printing, rarity and release date. */
export interface TcgCsvQuote {
  productId: string;
  /** The product's name and number as TCGplayer lists them ("Snorlax", "TG10/TG30"). */
  name: string;
  number: string;
  /** The set, without TCGplayer's series prefix ("SWSH11: Lost Origin Trainer Gallery" → "Lost Origin Trainer Gallery"). */
  set: string;
  url: string;
  /** TCGplayer's market price in US$ for the card's printing; null when it has none today. */
  usd: number | null;
  rarity: string | null;
  released: string | null;
}

/** What a card says about itself, for finding it. */
export interface TcgCsvCard {
  name?: unknown;
  set?: unknown;
  setCode?: unknown;
  number?: unknown;
  variant?: unknown;
  rarity?: unknown;
  /** The set TCGdex has it in, when it found it. */
  tcgdexSet?: string | null;
}

const fold = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
/** "051/165" → "51", "TG10/TG30" → "tg10", "SWSH050" → "swsh50": the number on the card, however it's written. */
export const ownNumber = (s: unknown) => {
  const n = String(s ?? '').split('/')[0].replace(/\s+/g, '').toLowerCase();
  const m = /^([a-z]*)0*(\d+)([a-z]*)$/.exec(n);
  return m ? `${m[1]}${m[2]}${m[3]}` : n;
};
/** "SWSH11: Lost Origin Trainer Gallery" → "Lost Origin Trainer Gallery"; "Base Set" stays. */
export const setName = (g: { name: string }) => g.name.replace(/^[A-Za-z]{1,6}\d{0,3}[a-z]?:\s*/, '').trim();
const numberOf = (p: TcgProduct) => p.extendedData?.find((e) => e.name === 'Number')?.value ?? null;
const extended = (p: TcgProduct, name: string) => p.extendedData?.find((e) => e.name === name)?.value ?? null;

/** A product's name without its number, and what its brackets say: "Eevee (Poke Ball Pattern)" → Eevee, "Poke Ball Pattern". */
export function productName(name: string): { base: string; variant: string } {
  let base = name.replace(/\s+-\s+[A-Za-z]*\d+[A-Za-z]*(?:\/[A-Za-z]*\d+[A-Za-z]*)?\s*$/, '');
  const variant = [...base.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2]).join(' ');
  base = base.replace(/\s*(\([^)]*\)|\[[^\]]*\])\s*/g, ' ').trim();
  return { base, variant };
}

/**
 * Whether a product's bracket names the card's variant: none for a plain card ("Reverse Holo" is a
 * printing of the same product), the same pattern or stamp for a special one ("Poke Ball" and
 * "(Poke Ball Pattern)"). TCGdex's way of reading a Variant (catalog.ts) tells them apart.
 */
export function variantFits(cardVariant: unknown, productVariant: string): boolean {
  const none: TcgdexCard = { id: '', localId: '', name: '', set: { id: '', name: '' }, variants_detailed: [] };
  const card = chooseVariant(none, cardVariant);
  if (!productVariant.trim()) return !card.special;
  if (!card.special) return false;
  // The product's bracket read as a TCGdex variant's features: both must name the same thing.
  const asVariant = (text: string) => fold(text.replace(/\b(pattern|stamp(ed)?|holo(foil)?|reverse|foil)\b/gi, ''));
  const a = asVariant(String(cardVariant ?? '')), b = asVariant(productVariant);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

/** The sets a card could be in, best first: its own set's name (or TCGdex's) or code, then sets that start or end with it (a Trainer Gallery, "151" for "Scarlet & Violet 151"). */
export function candidateGroups(groups: TcgGroup[], card: TcgCsvCard): TcgGroup[][] {
  const names = [card.set, card.tcgdexSet].map(fold).filter(Boolean);
  const code = fold(card.setCode);
  if (!names.length && !code) return [];
  const exact = groups.filter((g) => names.includes(fold(setName(g))) || names.includes(fold(g.name)) || (!!code && fold(g.abbreviation) === code));
  const near = groups.filter((g) => !exact.includes(g) && names.some((n) => n.length >= 3 && (fold(setName(g)).startsWith(n) || fold(setName(g)).endsWith(n))));
  return [exact, near].filter((t) => t.length);
}

/** The card's product in a set: the same number and name, and a bracket that names its variant (or none). Null unless exactly one fits. */
export function chooseProduct(products: TcgProduct[], card: TcgCsvCard, productId?: string | null): TcgProduct | null {
  if (productId) return products.find((p) => String(p.productId) === productId) ?? null;
  const want = ownNumber(card.number);
  if (!want || !fold(card.name)) return null;
  const fits = products.filter((p) => {
    const n = numberOf(p);
    if (!n || ownNumber(n) !== want) return false;
    const { base, variant } = productName(p.name);
    return (fold(base) === fold(card.name) || similarity(base, String(card.name)) >= 0.85) && variantFits(card.variant, variant);
  });
  return fits.length === 1 ? fits[0] : null;
}

/** TCGplayer's market price (US$) for the card's printing: the same kind first (a pattern is listed as holofoil), then, unless strict, the others. */
export function tcgPrice(prices: TcgPrice[], productId: number, want: Printing, special: boolean): number | null {
  const list: Record<string, { market: number | null }> = {};
  for (const p of prices) if (p.productId === productId) list[p.subTypeName] = { market: typeof p.marketPrice === 'number' && p.marketPrice > 0 ? Math.round(p.marketPrice * 100) / 100 : null };
  const priced = (v: { market: number | null }) => v.market != null;
  const hit = special ? pickPrinting(list, { kind: 'holo', first: want.first, strict: false }, priced) : pickPrinting(list, want, priced);
  return hit?.market ?? null;
}

export interface TcgCsvOptions {
  fetcher?: Fetcher;
  now?: () => Date;
  /** Pause between downloads (tcgcsv.com is one person's hobby). */
  gapMs?: number;
}

/** Asks tcgcsv.com about cards, keeping each day's downloads. */
export class TcgCsv {
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly gapMs: number;
  private day = '';
  private groups: Promise<TcgGroup[]> | null = null;
  private sets = new Map<number, Promise<{ products: TcgProduct[]; prices: TcgPrice[] }>>();
  private last = 0;
  private streak = 0;
  static readonly breakerAfter = 3;
  /** Downloads since the binder started, for the logs and tests. */
  downloads = 0;

  constructor(o: TcgCsvOptions = {}) {
    this.fetcher = o.fetcher ?? fetch;
    this.now = o.now ?? (() => new Date());
    this.gapMs = o.gapMs ?? 250;
  }

  /** Start of an update: ask again even if it kept failing. */
  reset() {
    this.streak = 0;
  }

  private fresh() {
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.groups = null;
      this.sets.clear();
    }
  }

  private async json<T>(path: string): Promise<T> {
    if (this.streak >= TcgCsv.breakerAfter) throw new SourceError("Skipped: tcgcsv.com kept failing, so it isn't asked again until the next price update.");
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      this.downloads++;
      const res = await get(this.fetcher, `${TCGCSV}${path}`, { headers: { Accept: 'application/json' } }, { timeoutMs: 20_000, attempts: 2, maxWaitMs: 5_000 });
      const body = (await res.json()) as { success?: boolean; results?: T };
      if (!Array.isArray(body.results)) throw new SourceError('tcgcsv.com sent no results');
      this.streak = 0;
      return body.results;
    } catch (err) {
      this.streak++;
      throw err;
    } finally {
      this.last = Date.now();
    }
  }

  /** Today's list of Pokémon sets; a failed download is tried again next time. */
  groupList(): Promise<TcgGroup[]> {
    this.fresh();
    this.groups ??= this.json<TcgGroup[]>('/groups').catch((err) => {
      this.groups = null;
      throw err;
    });
    return this.groups;
  }

  /** One set's products and prices, downloaded at most once a day. */
  group(groupId: number): Promise<{ products: TcgProduct[]; prices: TcgPrice[] }> {
    this.fresh();
    let s = this.sets.get(groupId);
    if (!s) {
      s = (async () => ({ products: await this.json<TcgProduct[]>(`/${groupId}/products`), prices: await this.json<TcgPrice[]>(`/${groupId}/prices`) }))();
      s.catch(() => this.sets.delete(groupId));
      this.sets.set(groupId, s);
    }
    return s;
  }

  /**
   * The card in TCGplayer's catalog: its product (`productId` when the card databases or the person
   * named it), found in the card's set by number, name and variant; null when it isn't certain.
   */
  async quote(card: TcgCsvCard, productId?: string | null): Promise<TcgCsvQuote | null> {
    const tiers = candidateGroups(await this.groupList(), card);
    for (const tier of tiers) {
      // Too many sets to look through means the card's set name says too little.
      if (tier.length > 4) continue;
      const found: { g: TcgGroup; p: TcgProduct; prices: TcgPrice[] }[] = [];
      for (const g of tier) {
        const s = await this.group(g.groupId);
        const p = chooseProduct(s.products, card, productId);
        if (p) found.push({ g, p, prices: s.prices });
      }
      if (found.length > 1) return null;
      if (found.length === 1) {
        const { g, p, prices } = found[0];
        const special = !!productName(p.name).variant;
        return {
          productId: String(p.productId),
          name: productName(p.name).base,
          number: numberOf(p) ?? '',
          set: setName(g),
          url: p.url ?? `https://www.tcgplayer.com/product/${p.productId}`,
          usd: tcgPrice(prices, p.productId, printingOf(card.variant, card.rarity), special),
          rarity: mapRarity(extended(p, 'Rarity')),
          released: releaseDate(g.publishedOn ?? ''),
        };
      }
    }
    return null;
  }
}
