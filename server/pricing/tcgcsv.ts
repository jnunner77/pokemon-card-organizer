// TCGplayer's own catalog, from tcgcsv.com: a free public copy of TCGplayer's catalog API (sets,
// products and prices as JSON, no key), refreshed every day around 20:00 UTC. It's the fallback
// for what the card databases (catalog.ts) don't have: a card TCGdex has no TCGplayer price for
// (Lost Origin's Trainer Gallery Snorlax), a card TCGdex doesn't know at all, its picture, and its
// blank rarity and release date. Pokémon is category 3; each set is a "group" with its products
// (cards and sealed products) and their prices by printing ("Normal", "Holofoil", "Reverse
// Holofoil"…). The binder downloads the list of sets and only the sets its cards need, each at
// most once a day, a quarter second apart, and stops asking for the rest of an update after
// failing three times in a row.

import { mapRarity } from '#domain/catalog/rarity.ts';
import { similarity } from '#domain/catalog/names.ts';
import { extended, ownNumber, productName, setName, type TcgGroup, type TcgPrice, type TcgProduct } from '#domain/catalog/tcgplayer.ts';
import { TcgCsvClient } from '#infrastructure/catalog/tcgcsv.ts';
import { chooseVariant, pickPrinting, printingOf, type Printing, type TcgdexCard } from './catalog.ts';
import { releaseDate } from './sources.ts';

// Downloading from tcgcsv.com is the layers' (src/infrastructure/catalog/tcgcsv.ts), and reading
// its sets and products the domain's (src/domain/catalog/tcgplayer.ts).
export { ownNumber, productName, setName, type TcgGroup, type TcgPrice, type TcgProduct } from '#domain/catalog/tcgplayer.ts';
export type { TcgCsvOptions } from '#infrastructure/catalog/tcgcsv.ts';

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
export function candidateGroups(groups: readonly TcgGroup[], card: TcgCsvCard): TcgGroup[][] {
  const names = [card.set, card.tcgdexSet].map(fold).filter(Boolean);
  const code = fold(card.setCode);
  if (!names.length && !code) return [];
  const exact = groups.filter((g) => names.includes(fold(setName(g))) || names.includes(fold(g.name)) || (!!code && fold(g.abbreviation) === code));
  const near = groups.filter((g) => !exact.includes(g) && names.some((n) => n.length >= 3 && (fold(setName(g)).startsWith(n) || fold(setName(g)).endsWith(n))));
  return [exact, near].filter((t) => t.length);
}

/** The card's product in a set: the same number and name, and a bracket that names its variant (or none). Null unless exactly one fits. */
export function chooseProduct(products: readonly TcgProduct[], card: TcgCsvCard, productId?: string | null): TcgProduct | null {
  if (productId) return products.find((p) => String(p.productId) === productId) ?? null;
  const want = ownNumber(card.number);
  if (!want || !fold(card.name)) return null;
  const fits = products.filter((p) => {
    const n = extended(p, 'Number');
    if (!n || ownNumber(n) !== want) return false;
    const { base, variant } = productName(p.name);
    return (fold(base) === fold(card.name) || similarity(base, String(card.name)) >= 0.85) && variantFits(card.variant, variant);
  });
  return fits.length === 1 ? fits[0] : null;
}

/** TCGplayer's market price (US$) for the card's printing: the same kind first (a pattern is listed as holofoil), then, unless strict, the others. */
export function tcgPrice(prices: readonly TcgPrice[], productId: number, want: Printing, special: boolean): number | null {
  const list: Record<string, { market: number | null }> = {};
  for (const p of prices) if (p.productId === productId) list[p.subTypeName] = { market: typeof p.marketPrice === 'number' && p.marketPrice > 0 ? Math.round(p.marketPrice * 100) / 100 : null };
  const priced = (v: { market: number | null }) => v.market != null;
  const hit = special ? pickPrinting(list, { kind: 'holo', first: want.first, strict: false }, priced) : pickPrinting(list, want, priced);
  return hit?.market ?? null;
}

/** Asks tcgcsv.com about cards (downloading each set at most once a day), for the price update. */
export class TcgCsv extends TcgCsvClient {
  /**
   * The card in TCGplayer's catalog: its product (`productId` when the card databases or the person
   * named it), found in the card's set by number, name and variant; null when it isn't certain.
   */
  async quote(card: TcgCsvCard, productId?: string | null): Promise<TcgCsvQuote | null> {
    const tiers = candidateGroups(await this.groupList(), card);
    for (const tier of tiers) {
      // Too many sets to look through means the card's set name says too little.
      if (tier.length > 4) continue;
      const found: { g: TcgGroup; p: TcgProduct; prices: readonly TcgPrice[] }[] = [];
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
          number: extended(p, 'Number') ?? '',
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
