// Prices and pictures from the Pokémon card databases' own APIs, with nothing scraped:
//
// - TCGdex (https://tcgdex.dev, free, no key), which the binder already matches every card to for
//   its details (details.ts). Each card lists its variants (regular, reverse, holo, patterns such
//   as Poké Ball and Master Ball, stamps, 1st Edition, Shadowless), each with its own TCGplayer
//   and Cardmarket products and prices (in euros), refreshed daily. A card is priced from the
//   variant its Variant field names, never from another variant's price. TCGdex's own pictures
//   (600×825) stand in when there's no larger one.
// - pokemontcg.io (https://pokemontcg.io, free; a key, POKEMONTCG_API_KEY, raises its limits),
//   whose card pictures are the largest official ones (733×1024). Its TCGplayer prices stand in when
//   TCGdex has none; its Cardmarket prices are left alone (they stopped updating in 2025). Its
//   rarity, illustrator, set code and release date fill what TCGdex left blank.
//
// The updater (updater.ts) compares these with PriceCharting's price and logs the highest.

import { type DetailField, mapRarity, similarity } from '../details';
import { type Fetcher, SourceError, get, releaseDate } from './sources';

const TCGDEX = 'https://api.tcgdex.net/v2/en';
const PTCG = 'https://api.pokemontcg.io/v2';
/** A card pokemontcg.io didn't have is looked for again after this long. */
export const PTCG_RETRY_MS = 7 * 86_400_000;

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
export function printingOf(variant: unknown, rarity: unknown): Printing {
  const v = String(variant ?? '');
  const kind = /reverse/i.test(v) ? 'reverse' : /holo|foil/i.test(v) ? 'holo' : 'normal';
  return { kind, first: /1st|first/i.test(v), strict: kind === 'normal' && /^(common|uncommon)$/i.test(String(rarity ?? '').trim()) };
}

/** A price list key, TCGdex's ("reverse-holofoil", "1st-edition-holofoil") or pokemontcg.io's ("reverseHolofoil"), as a printing. */
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
  // A plain card named "Holo" or "Reverse" must be that kind; a pattern or stamp names its variant on its own.
  const kinds = claimed.length || kind === 'normal' ? order : [kind];
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

// ---- pokemontcg.io ------------------------------------------------------------------

export interface PtcgCard {
  id: string;
  name: string;
  number: string;
  set: { id: string; name: string; ptcgoCode?: string; printedTotal?: number; releaseDate?: string };
  rarity?: string;
  artist?: string;
  images?: { small?: string; large?: string };
  tcgplayer?: { prices?: Record<string, { market?: number | null }> } | null;
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
/** "051" → "51", "TG01" → "tg01": the number on the card, however it's written. */
const ownNumber = (s: unknown) => {
  const n = String(s ?? '').split('/')[0].replace(/\s+/g, '').toLowerCase();
  return /^\d+$/.test(n) ? String(Number(n)) : n;
};

/**
 * The pokemontcg.io card that is this TCGdex card: the same number in the same set (by set code,
 * name, or a similar name with the same set size). Null unless exactly one fits.
 */
export function choosePtcg(list: PtcgCard[], c: TcgdexCard, setCode?: string | null): PtcgCard | null {
  const total = c.set.cardCount?.official;
  const fits = list.filter((p) => {
    if (ownNumber(p.number) !== ownNumber(c.localId)) return false;
    if (setCode && p.set.ptcgoCode && norm(p.set.ptcgoCode) === norm(setCode)) return true;
    if (norm(p.set.name) === norm(c.set.name)) return true;
    return !!total && p.set.printedTotal === total && similarity(p.set.name, c.set.name) >= 0.6;
  });
  const exact = fits.filter((p) => norm(p.set.name) === norm(c.set.name));
  if (exact.length === 1) return exact[0];
  return fits.length === 1 ? fits[0] : null;
}

/** TCGplayer's market price (US$) for the printing, from a pokemontcg.io card. */
export function ptcgTcgplayer(p: PtcgCard, want: Printing): number | null {
  const hit = pickPrinting(p.tcgplayer?.prices, want, (v) => usd(v.market) != null);
  return hit ? usd(hit.market) : null;
}

/** A pokemontcg.io card's details, in the binder's words ("Rare Ultra" → "Ultra Rare", "2023/09/22" → "2023-09-22"). */
export function ptcgDetails(p: PtcgCard): Record<DetailField, string | null> {
  const t = (s: unknown) => (typeof s === 'string' && s.trim() ? s.trim() : null);
  return { set: t(p.set.name), setCode: t(p.set.ptcgoCode), rarity: mapRarity(p.rarity), artist: t(p.artist), released: releaseDate(String(p.set.releaseDate ?? '').replace(/\//g, '-')) };
}

// ---- one card -----------------------------------------------------------------------

/** What the card databases say about one card today. */
export interface CatalogQuote {
  tcgdexId: string;
  /** pokemontcg.io's id for the card; null when it has none (looked for again after PTCG_RETRY_MS). */
  ptcgId: string | null;
  /** When pokemontcg.io was last searched for the card, and last read. */
  ptcgSearchedAt: string | null;
  ptcgReadAt: string | null;
  /** TCGplayer's market price in US$ for the card's printing, and its TCGplayer product. */
  tcgplayer: { usd: number; productId: string | null } | null;
  /** Cardmarket's trend price in euros for the card's printing. */
  cardmarketEur: number | null;
  /** The largest official picture: pokemontcg.io's. */
  image: string | null;
  /** TCGdex's own picture (600×825), for a card with none. */
  fallbackImage: string | null;
  /** The card's Variant names more than a plain printing (a pattern, stamp, edition…). */
  special: boolean;
  /** No TCGdex variant fits the card's Variant: the databases' prices aren't used for it. */
  unknownVariant: boolean;
  /** The TCGdex variant priced, in words (for a special one). */
  variant: string | null;
  /** TCGplayer products of the card's plain printings: an automatic link to one of these is wrong for a special variant. */
  plainProducts: string[];
  /** pokemontcg.io's set, set code, rarity, illustrator and release date, for filling blanks. */
  details: Record<DetailField, string | null> | null;
  /** The card's name and set as TCGdex has them, for naming a TCGplayer product found this way. */
  name: string;
  set: string;
  number: string;
  /** What failed, if a database didn't answer (the rest is still used). */
  errors: string[];
}

export interface CatalogOptions {
  fetcher?: Fetcher;
  /** pokemontcg.io key (POKEMONTCG_API_KEY): optional, raises its request limits. */
  ptcgKey?: string;
  now?: () => Date;
}

/** Asks TCGdex and pokemontcg.io about cards. A database that keeps failing is left alone until reset(). */
export class Catalog {
  private readonly fetcher: Fetcher;
  private readonly ptcgKey?: string;
  private readonly now: () => Date;
  private streak = { tcgdex: 0, ptcg: 0 };
  static readonly breakerAfter = 3;

  constructor(o: CatalogOptions = {}) {
    this.fetcher = o.fetcher ?? fetch;
    this.ptcgKey = o.ptcgKey || undefined;
    this.now = o.now ?? (() => new Date());
  }

  /** Start of a price update: ask every database again. */
  reset() {
    this.streak = { tcgdex: 0, ptcg: 0 };
  }

  private async json<T>(db: 'tcgdex' | 'ptcg', url: string): Promise<T> {
    if (this.streak[db] >= Catalog.breakerAfter) throw new SourceError(`Skipped: ${db === 'tcgdex' ? 'TCGdex' : 'pokemontcg.io'} kept failing during this update.`);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (db === 'ptcg' && this.ptcgKey) headers['X-Api-Key'] = this.ptcgKey;
      // pokemontcg.io is slow at times and only adds pictures and details: it isn't waited on long.
      const patience = db === 'ptcg' ? { timeoutMs: 10_000, attempts: 2 } : {};
      const out = (await (await get(this.fetcher, url, { headers }, patience)).json()) as T;
      this.streak[db] = 0;
      return out;
    } catch (err) {
      this.streak[db]++;
      throw err;
    }
  }

  /**
   * Today's prices and picture for the TCGdex card `tcgdexId`. `known` is what an earlier quote
   * found on pokemontcg.io (its id, or that it had none, when it was searched and last read).
   * pokemontcg.io is only asked while the card needs it: for a large picture (`picture`: what the
   * card has now), for blank details (`blanks`, at most weekly), or for a price TCGdex lacks.
   */
  async quote(
    tcgdexId: string,
    card: { variant?: unknown; rarity?: unknown; picture?: 'large' | 'other' | null; blanks?: boolean },
    known: { ptcgId?: string | null; ptcgSearchedAt?: string | null; ptcgReadAt?: string | null } = {},
    setCode?: string | null,
  ): Promise<CatalogQuote> {
    const errors: string[] = [];
    const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
    const td = await this.json<TcgdexCard>('tcgdex', `${TCGDEX}/cards/${encodeURIComponent(tcgdexId)}`);
    // The card's own variant's prices; TCGdex's card-wide lists only for a card with no variant list.
    const want = printingOf(card.variant, card.rarity);
    const chosen = chooseVariant(td, card.variant);
    const own = chosen.variant ? variantPrices(chosen.variant) : null;
    const plain = !chosen.special && !chosen.unknown;
    const tcgplayer = chosen.unknown ? null : own ? own.tcgplayer : tcgdexTcgplayer(td, want);
    const cardmarketEur = chosen.unknown ? null : own ? own.cardmarketEur : tcgdexCardmarket(td, want);

    const now = this.now().getTime();
    const older = (at: string | null | undefined) => !at || Date.parse(at) < now - PTCG_RETRY_MS;
    // A special variant is pictured by its own TCGplayer product instead.
    const wantsPicture = card.picture === undefined || card.picture === null || (card.picture === 'other' && !chosen.special);
    const needPtcg = wantsPicture || (plain && !tcgplayer) || (!!card.blanks && older(known.ptcgReadAt));
    let ptcgId = known.ptcgId ?? null;
    let ptcgSearchedAt = known.ptcgSearchedAt ?? null;
    let ptcgReadAt = known.ptcgReadAt ?? null;
    let pc: PtcgCard | null = null;
    const stale = older(ptcgSearchedAt);
    try {
      if (!needPtcg) {
        // Nothing pokemontcg.io would add today.
      } else if (!ptcgId && stale) {
        const q = `name:"${td.name.replace(/["\\]/g, '')}" number:${ownNumber(td.localId) || td.localId}`;
        const found = await this.json<{ data?: PtcgCard[] }>('ptcg', `${PTCG}/cards?q=${encodeURIComponent(q)}&select=id,name,number,set,images,tcgplayer,rarity,artist`);
        pc = choosePtcg(found.data ?? [], td, setCode);
        ptcgId = pc?.id ?? null;
        ptcgSearchedAt = this.now().toISOString();
        if (pc) ptcgReadAt = ptcgSearchedAt;
      } else if (ptcgId) {
        pc = (await this.json<{ data?: PtcgCard }>('ptcg', `${PTCG}/cards/${encodeURIComponent(ptcgId)}`)).data ?? null;
        ptcgReadAt = this.now().toISOString();
      }
    } catch (err) {
      errors.push(`pokemontcg.io: ${msg(err)}`);
    }
    // pokemontcg.io only prices the plain printings.
    const kindOf = (t: string): Printing['kind'] => (t === 'reverse' ? 'reverse' : t === 'holo' ? 'holo' : 'normal');
    const fromPtcg = plain && pc ? ptcgTcgplayer(pc, chosen.variant ? { kind: kindOf(chosen.variant.type), first: false, strict: true } : want) : null;
    const plainProducts = [
      ...(td.variants_detailed ?? []).filter((v) => !featuresOf(v).length).map((v) => v.thirdParty?.tcgplayer),
      ...Object.values(td.pricing?.tcgplayer ?? {}).map((v) => (typeof v === 'object' && v ? v.productId : undefined)),
    ]
      .filter((n): n is number => typeof n === 'number')
      .map((n) => String(Math.trunc(n)));
    return {
      tcgdexId,
      ptcgId,
      ptcgSearchedAt,
      ptcgReadAt,
      tcgplayer: tcgplayer ?? (fromPtcg != null ? { usd: fromPtcg, productId: null } : null),
      cardmarketEur,
      fallbackImage: td.image ? `${td.image}/high.png` : null,
      special: chosen.special,
      unknownVariant: chosen.unknown,
      variant: chosen.special && chosen.variant ? variantLabel(chosen.variant) : null,
      plainProducts: [...new Set(plainProducts)],
      image: pc?.images?.large ?? null,
      details: pc ? ptcgDetails(pc) : null,
      name: td.name,
      set: td.set.name,
      number: td.localId,
      errors,
    };
  }
}
