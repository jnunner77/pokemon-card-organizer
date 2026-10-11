// Prices and pictures from the TCGdex card database's API, with nothing scraped:
//
// - TCGdex (https://tcgdex.dev, free, no key), which the binder already matches every card to for
//   its details (details.ts). Each card lists its variants (regular, reverse, holo, patterns such
//   as Poké Ball and Master Ball, stamps, 1st Edition, Shadowless), each with its own TCGplayer
//   and Cardmarket products and prices (in euros), refreshed daily. A card is priced from the
//   variant its Variant field names, never from another variant's price. Its TCGplayer product's
//   picture (717×1000), then TCGdex's own (600×825), picture the card.
//
// TCGplayer's own catalog (tcgcsv.ts) fills what TCGdex lacks. The updater (updater.ts) blends
// these with PriceCharting's price.

import { type Fetcher, SourceError, get } from './sources';

const TCGDEX = 'https://api.tcgdex.net/v2/en';

/** Which printing of a card to price. `strict`: never borrow another printing's price. */
export interface Printing {
  kind: 'normal' | 'holo' | 'reverse';
  first: boolean;
  strict: boolean;
}

/**
 * The printing a card's variant names: "Reverse Holo" → reverse, "Holo" or "Foil" → holo, "1st
 * Edition" → first edition, anything else the regular card. Commons and uncommons (which come in a
 * regular version) are strict: a missing price isn't taken from the holo.
 */
/** "Non-Holo", "Non Holo", "Nonholo": the plain printing, said outright (a holo rare's theme deck copy). */
const NON_HOLO = /\bnon[-\s]?holo/i;

export function printingOf(variant: unknown, rarity: unknown): Printing {
  const v = String(variant ?? '');
  const kind = /reverse/i.test(v) ? 'reverse' : NON_HOLO.test(v) ? 'normal' : /holo|foil/i.test(v) ? 'holo' : 'normal';
  return { kind, first: /1st|first/i.test(v), strict: kind === 'normal' && /^(common|uncommon)$/i.test(String(rarity ?? '').trim()) };
}

/** A TCGdex price list key ("reverse-holofoil", "1st-edition-holofoil") as a printing. */
function keyPrinting(key: string): { kind: Printing['kind']; first: boolean } {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return { kind: k.includes('reverse') ? 'reverse' : k.includes('holo') ? 'holo' : 'normal', first: k.startsWith('1stedition') };
}

/**
 * The price list entry for the printing: the same kind of printing (same edition first), or,
 * unless strict, the regular card, then the holo, then the reverse holo (a holo-only rare has no
 * regular price, so its holo price is the card's).
 */
export function pickPrinting<T>(list: Record<string, T> | null | undefined, want: Printing, priced: (t: T) => boolean): T | null {
  const entries = Object.entries(list ?? {}).filter(([, v]) => v && typeof v === 'object' && priced(v));
  const kinds: Printing['kind'][] = [want.kind, ...(want.strict ? [] : (['normal', 'holo', 'reverse'] as const).filter((k) => k !== want.kind))];
  for (const kind of kinds) {
    const same = entries.filter(([k]) => keyPrinting(k).kind === kind);
    const hit = same.find(([k]) => keyPrinting(k).first === want.first) ?? same[0];
    if (hit) return hit[1];
  }
  return null;
}

const usd = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null);

// ---- TCGdex -------------------------------------------------------------------------

interface TcgdexPricing {
  tcgplayer?: Record<string, { productId?: number; marketPrice?: number | null } | string> | null;
  cardmarket?: Record<string, number | string | null> | null;
}
/** One of a TCGdex card's variants: its kind, pattern (foil), stamps and subtype, with its own products and prices. */
export interface TcgdexVariant {
  type: string;
  subtype?: string;
  foil?: string;
  stamp?: string[];
  thirdParty?: { tcgplayer?: number; cardmarket?: number };
  pricing?: TcgdexPricing | null;
}
export interface TcgdexCard {
  id: string;
  localId: string;
  name: string;
  image?: string;
  set: { id: string; name: string; cardCount?: { official?: number } };
  pricing?: TcgdexPricing | null;
  variants_detailed?: TcgdexVariant[] | null;
}

/** TCGplayer's market price (US$) and product id for the printing, from a TCGdex card. */
export function tcgdexTcgplayer(c: TcgdexCard, want: Printing): { usd: number; productId: string | null } | null {
  const list = c.pricing?.tcgplayer as Record<string, { productId?: number; marketPrice?: number | null }> | undefined;
  const hit = pickPrinting(list, want, (v) => usd(v.marketPrice) != null);
  if (!hit) return null;
  return { usd: usd(hit.marketPrice)!, productId: hit.productId ? String(Math.trunc(hit.productId)) : null };
}

/**
 * Cardmarket's trend price (€) for the printing, from a TCGdex card. Cardmarket keeps one product
 * per card: its "-holo" prices are the reverse holo; the plain ones are the card itself, holo rares
 * included.
 */
export function tcgdexCardmarket(c: TcgdexCard, want: Printing): number | null {
  const cm = c.pricing?.cardmarket;
  if (!cm) return null;
  const plain = usd(cm.trend), reverse = usd(cm['trend-holo']);
  if (want.kind === 'reverse') return reverse ?? (want.strict ? null : plain);
  return plain ?? (want.strict ? null : reverse);
}

// ---- the card's own variant ---------------------------------------------------------

/** What sets a TCGdex variant apart from the regular card: its pattern, stamps and subtype ("unlimited" is the default). */
export const featuresOf = (v: TcgdexVariant) => [v.foil, ...(v.stamp ?? []), v.subtype && v.subtype !== 'unlimited' ? v.subtype : null].filter((f): f is string => !!f);

/** Whether a card's Variant text names a TCGdex feature, however it's written: "Poke Ball" or "Ball", "1st Ed", "Cosmo Holo". */
export function namesFeature(text: string, feature: string): boolean {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const f = feature.toLowerCase();
  if (f === 'pokeball') return /poke\s*-?\s*ball/.test(t) || (/\bball\b/.test(t) && !/(master|great|ultra|quick|love|friend|dusk|heal|premier)\s*-?\s*ball/.test(t));
  if (f === 'masterball') return /master\s*-?\s*ball/.test(t);
  if (f === '1st-edition') return /\b1st\b|first\s*ed/.test(t);
  if (f === 'cosmos') return /cosmo/.test(t);
  return !!norm(f) && norm(t).includes(norm(f));
}

/**
 * Words in a Variant that only say which of the plain printings it is, or describe the card itself
 * ("Full Art", "Holo Rare": its own number, not another printing of it).
 */
const PLAIN_WORDS = new Set([
  ...['reverse', 'rev', 'rh', 'holo', 'holofoil', 'foil', 'normal', 'regular', 'non', 'nonholo', 'unlimited', 'standard', 'version', 'print', 'printing', 'card', 'edition', 'ed'],
  ...['rare', 'art', 'full', 'alt', 'alternate', 'illustration', 'special', 'secret', 'promo', 'black', 'star', 'gold', 'rainbow', 'shiny', 'ultra', 'hyper', 'double', 'trainer', 'gallery'],
  ...['ex', 'gx', 'v', 'vmax', 'vstar', 'mega', 'tg', 'ir', 'sir', 'ar', 'sar', 'fa', 'aa', 'ur', 'hr'],
]);
/** Words that only qualify a pattern or stamp the Variant names ("Poké Ball pattern"); on their own ("Stamped") they name a variant. */
const QUALIFIERS = new Set(['stamp', 'stamped', 'pattern']);

/**
 * The TCGdex variant a card's Variant text names: the one with the pattern, stamps and subtype the
 * text names and the fewest others, of the kind it names (regular first, then holo, then reverse, when
 * it names none). `special`: the text names more than a plain printing. `unknown`: it names
 * something no TCGdex variant has (or TCGdex lists no variants), so no TCGdex price fits it.
 */
export function chooseVariant(c: TcgdexCard, variantText: unknown): { variant: TcgdexVariant | null; special: boolean; unknown: boolean } {
  const text = String(variantText ?? '');
  const list = c.variants_detailed ?? [];
  const claimed = [...new Set(list.flatMap(featuresOf))].filter((f) => namesFeature(text, f));
  // Words left once the plain printings and the named features are accounted for: an unlisted variant.
  const left = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !PLAIN_WORDS.has(w) && !(QUALIFIERS.has(w) && claimed.length) && !claimed.some((f) => norm(f).includes(w) || namesFeature(w, f)));
  const first = /\b1st\b|first\s*ed/i.test(text);
  const special = claimed.length > 0 || left.length > 0 || (first && !claimed.includes('1st-edition'));
  if (left.length || (first && !claimed.includes('1st-edition') && list.length)) return { variant: null, special: true, unknown: true };
  if (!list.length) return { variant: null, special, unknown: special };
  // Variants with every feature named (none, for a plain card), fewest others first: "1st Edition"
  // finds Base Set's 1st Edition card, which TCGdex also marks Shadowless.
  const extra = (v: TcgdexVariant) => featuresOf(v).length - claimed.length;
  const fits = list
    .filter((v) => claimed.every((f) => featuresOf(v).includes(f)) && (claimed.length > 0 || extra(v) === 0))
    .sort((a, b) => extra(a) - extra(b))
    .filter((v, _, all) => extra(v) === extra(all[0]));
  const kind = printingOf(text, null).kind;
  const order = kind === 'reverse' ? ['reverse', 'holo', 'normal'] : kind === 'holo' ? ['holo', 'reverse', 'normal'] : ['normal', 'holo', 'reverse'];
  // A plain card named "Holo", "Reverse" or "Non-Holo" must be that kind; a pattern or stamp names its variant on its own.
  const kinds = claimed.length || (kind === 'normal' && !NON_HOLO.test(text)) ? order : [kind];
  for (const k of kinds) {
    const hit = fits.find((v) => v.type === k);
    if (hit) return { variant: hit, special, unknown: false };
  }
  return { variant: null, special, unknown: true };
}

/**
 * A TCGdex variant's own prices: TCGplayer's market price (US$) for its product and Cardmarket's
 * trend (€; a reverse holo's is Cardmarket's "holo" price). Never another variant's.
 */
export function variantPrices(v: TcgdexVariant): { tcgplayer: { usd: number; productId: string | null } | null; cardmarketEur: number | null } {
  const kind: Printing['kind'] = v.type === 'reverse' ? 'reverse' : v.type === 'holo' ? 'holo' : 'normal';
  const first = (v.stamp ?? []).includes('1st-edition');
  const list = v.pricing?.tcgplayer as Record<string, { productId?: number; marketPrice?: number | null }> | undefined;
  const priced = (x: { marketPrice?: number | null }) => usd(x.marketPrice) != null;
  // A pattern's own TCGplayer product (a Poké Ball reverse, say) is listed as a holofoil.
  const hit = pickPrinting(list, { kind, first, strict: true }, priced) ?? (v.foil ? pickPrinting(list, { kind: 'holo', first, strict: true }, priced) : null);
  const product = v.thirdParty?.tcgplayer ?? hit?.productId;
  const cm = v.pricing?.cardmarket;
  return {
    tcgplayer: hit ? { usd: usd(hit.marketPrice)!, productId: product ? String(Math.trunc(product)) : null } : null,
    cardmarketEur: cm ? usd(kind === 'reverse' ? cm['trend-holo'] : cm.trend) : null,
  };
}

/** "Master Ball reverse", "1st Edition Shadowless holo": a TCGdex variant in words, for the price note. */
export function variantLabel(v: TcgdexVariant): string {
  const words = featuresOf(v).map((f) => (f === 'pokeball' ? 'Poké Ball' : f === 'masterball' ? 'Master Ball' : f === '1st-edition' ? '1st Edition' : f.replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase())));
  return [...words, v.type === 'normal' ? 'regular' : v.type].join(' ');
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
// ---- one card -----------------------------------------------------------------------

/** What TCGdex says about one card today. */
export interface CatalogQuote {
  tcgdexId: string;
  /** TCGplayer's market price in US$ for the card's printing, and its TCGplayer product. */
  tcgplayer: { usd: number; productId: string | null } | null;
  /** Cardmarket's trend price in euros for the card's printing. */
  cardmarketEur: number | null;
  /** The TCGplayer product of the card's printing, even on a day TCGplayer has no price for it (its picture stands in, updater.ts). */
  tcgplayerProduct: string | null;
  /** TCGdex's own picture (600×825), the last to try for a card with none. */
  fallbackImage: string | null;
  /** The card's Variant names more than a plain printing (a pattern, stamp, edition…). */
  special: boolean;
  /** No TCGdex variant fits the card's Variant: TCGdex's prices aren't used for it. */
  unknownVariant: boolean;
  /** The TCGdex variant priced, in words (for a special one). */
  variant: string | null;
  /** TCGplayer products of the card's plain printings: an automatic link to one of these is wrong for a special variant. */
  plainProducts: string[];
  /** The card's name and set as TCGdex has them, for naming a TCGplayer product found this way. */
  name: string;
  set: string;
  number: string;
}

export interface CatalogOptions {
  fetcher?: Fetcher;
}

/** TCGdex isn't asked again until reset() once it kept failing. */
class Skipped extends SourceError {}

/** Asks TCGdex about cards. If it keeps failing it's left alone until reset(). */
export class Catalog {
  private readonly fetcher: Fetcher;
  private streak = 0;
  static readonly breakerAfter = 3;

  constructor(o: CatalogOptions = {}) {
    this.fetcher = o.fetcher ?? fetch;
  }

  /** Start of a price update: ask TCGdex again. */
  reset() {
    this.streak = 0;
  }

  private async json<T>(url: string): Promise<T> {
    if (this.streak >= Catalog.breakerAfter) throw new Skipped('Skipped: TCGdex kept failing during this update.');
    try {
      const out = (await (await get(this.fetcher, url, { headers: { Accept: 'application/json' } })).json()) as T;
      this.streak = 0;
      return out;
    } catch (err) {
      this.streak++;
      throw err;
    }
  }

  /** Today's prices and picture for the TCGdex card `tcgdexId`, priced as the card's own variant. */
  async quote(tcgdexId: string, card: { variant?: unknown; rarity?: unknown }): Promise<CatalogQuote> {
    const td = await this.json<TcgdexCard>(`${TCGDEX}/cards/${encodeURIComponent(tcgdexId)}`);
    // The card's own variant's prices; TCGdex's card-wide lists only for a card with no variant list.
    const want = printingOf(card.variant, card.rarity);
    const chosen = chooseVariant(td, card.variant);
    const own = chosen.variant ? variantPrices(chosen.variant) : null;
    const tcgplayer = chosen.unknown ? null : own ? own.tcgplayer : tcgdexTcgplayer(td, want);
    const cardmarketEur = chosen.unknown ? null : own ? own.cardmarketEur : tcgdexCardmarket(td, want);
    const plainProducts = [
      ...(td.variants_detailed ?? []).filter((v) => !featuresOf(v).length).map((v) => v.thirdParty?.tcgplayer),
      ...Object.values(td.pricing?.tcgplayer ?? {}).map((v) => (typeof v === 'object' && v ? v.productId : undefined)),
    ]
      .filter((n): n is number => typeof n === 'number')
      .map((n) => String(Math.trunc(n)));
    return {
      tcgdexId,
      tcgplayer,
      cardmarketEur,
      tcgplayerProduct: chosen.unknown ? null : (tcgplayer?.productId ?? (chosen.variant?.thirdParty?.tcgplayer ? String(Math.trunc(chosen.variant.thirdParty.tcgplayer)) : null)),
      fallbackImage: td.image ? `${td.image}/high.png` : null,
      special: chosen.special,
      unknownVariant: chosen.unknown,
      variant: chosen.special && chosen.variant ? variantLabel(chosen.variant) : null,
      plainProducts: [...new Set(plainProducts)],
      name: td.name,
      set: td.set.name,
      number: td.localId,
    };
  }
}
