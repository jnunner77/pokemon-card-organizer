import { norm } from './names.ts';
import type { TcgdexCard, TcgdexVariant } from './tcgdex.ts';

// Which printing of a card (regular, holo, reverse holo, a Poké Ball pattern, 1st Edition…) a
// card's Variant names, and that printing's own prices on TCGdex. A card is priced from the
// variant its Variant field names, never from another variant's price.

/** Which printing of a card to price. `strict`: never borrow another printing's price. */
export interface Printing {
  readonly kind: 'normal' | 'holo' | 'reverse';
  readonly first: boolean;
  readonly strict: boolean;
}

/** "Non-Holo", "Non Holo", "Nonholo": the plain printing, said outright (a holo rare's theme deck copy). */
const NON_HOLO = /\bnon[-\s]?holo/i;

/**
 * The printing a card's variant names: "Reverse Holo" → reverse, "Holo" or "Foil" → holo, "1st
 * Edition" → first edition, anything else the regular card. Commons and uncommons (which come in a
 * regular version) are strict: a missing price isn't taken from the holo.
 */
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
export function pickPrinting<T extends object>(list: Readonly<Record<string, T | string | number | null | undefined>> | null | undefined, want: Printing, priced: (t: T) => boolean): T | null {
  const entries: [string, T][] = [];
  for (const [k, v] of Object.entries(list ?? {})) if (v && typeof v === 'object' && priced(v)) entries.push([k, v]);
  const kinds: Printing['kind'][] = [want.kind, ...(want.strict ? [] : (['normal', 'holo', 'reverse'] as const).filter((k) => k !== want.kind))];
  for (const kind of kinds) {
    const same = entries.filter(([k]) => keyPrinting(k).kind === kind);
    const hit = same.find(([k]) => keyPrinting(k).first === want.first) ?? same[0];
    if (hit) return hit[1];
  }
  return null;
}

/** A price in US dollars, to the cent; null for anything that isn't a positive number. */
export const usd = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null);

type TcgplayerEntry = { readonly productId?: number | undefined; readonly marketPrice?: number | null | undefined };

/** TCGplayer's market price and product of an entry, when it has a price. */
function tcgplayerQuote(hit: TcgplayerEntry | null, product: number | undefined): { usd: number; productId: string | null } | null {
  const price = usd(hit?.marketPrice);
  if (!hit || price === null) return null;
  return { usd: price, productId: product ? String(Math.trunc(product)) : null };
}

/** TCGplayer's market price (US$) and product id for the printing, from a TCGdex card. */
export function tcgdexTcgplayer(c: TcgdexCard, want: Printing): { usd: number; productId: string | null } | null {
  const hit = pickPrinting<TcgplayerEntry>(c.pricing?.tcgplayer, want, (v) => usd(v.marketPrice) != null);
  return tcgplayerQuote(hit, hit?.productId);
}

/** What sets a TCGdex variant apart from the regular card: its pattern, stamps and subtype ("unlimited" is the default). */
export const featuresOf = (v: TcgdexVariant): string[] => [v.foil, ...(v.stamp ?? []), v.subtype && v.subtype !== 'unlimited' ? v.subtype : null].filter((f): f is string => !!f);

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

export interface ChosenVariant {
  readonly variant: TcgdexVariant | null;
  /** The text names more than a plain printing. */
  readonly special: boolean;
  /** It names something no TCGdex variant has (or TCGdex lists no variants), so no TCGdex price fits it. */
  readonly unknown: boolean;
}

/**
 * The TCGdex variant a card's Variant text names: the one with the pattern, stamps and subtype the
 * text names and the fewest others, of the kind it names (regular first, then holo, then reverse, when
 * it names none).
 */
export function chooseVariant(c: TcgdexCard, variantText: unknown): ChosenVariant {
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
  const named = list.filter((v) => claimed.every((f) => featuresOf(v).includes(f)) && (claimed.length > 0 || extra(v) === 0)).sort((a, b) => extra(a) - extra(b));
  const fewest = named[0] ? extra(named[0]) : 0;
  const fits = named.filter((v) => extra(v) === fewest);
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

/** A TCGdex variant's own prices: TCGplayer's market price (US$) for its product. Never another variant's. */
export function variantPrices(v: TcgdexVariant): { tcgplayer: { usd: number; productId: string | null } | null } {
  const kind: Printing['kind'] = v.type === 'reverse' ? 'reverse' : v.type === 'holo' ? 'holo' : 'normal';
  const first = (v.stamp ?? []).includes('1st-edition');
  const list = v.pricing?.tcgplayer;
  const priced = (x: TcgplayerEntry) => usd(x.marketPrice) != null;
  // A pattern's own TCGplayer product (a Poké Ball reverse, say) is listed as a holofoil.
  const hit = pickPrinting<TcgplayerEntry>(list, { kind, first, strict: true }, priced) ?? (v.foil ? pickPrinting<TcgplayerEntry>(list, { kind: 'holo', first, strict: true }, priced) : null);
  return { tcgplayer: tcgplayerQuote(hit, v.thirdParty?.tcgplayer ?? hit?.productId) };
}

/** "Master Ball reverse", "1st Edition Shadowless holo": a TCGdex variant in words, for the price note. */
export function variantLabel(v: TcgdexVariant): string {
  const spelled = featuresOf(v).map((f) => (f === 'pokeball' ? 'Poké Ball' : f === 'masterball' ? 'Master Ball' : f === '1st-edition' ? '1st Edition' : f.replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase())));
  return [...spelled, v.type === 'normal' ? 'regular' : v.type].join(' ');
}
