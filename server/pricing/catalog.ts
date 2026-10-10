// Prices and pictures from the Pokémon card databases' own APIs, with nothing scraped:
//
// - TCGdex (https://tcgdex.dev, free, no key), which the binder already matches every card to for
//   its details (details.ts). Each card carries TCGplayer's market price for every printing, with
//   the TCGplayer product id, and Cardmarket's prices in euros, both refreshed daily.
// - pokemontcg.io (https://pokemontcg.io, free; a key, POKEMONTCG_API_KEY, raises its limits),
//   whose card pictures are the largest official ones (733×1024). Its TCGplayer prices stand in when
//   TCGdex has none; its Cardmarket prices are left alone (they stopped updating in 2025).
//
// The updater (updater.ts) compares these with PriceCharting's price and logs the highest.

import { similarity } from '../details';
import { type Fetcher, SourceError, get } from './sources';

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
export interface TcgdexCard {
  id: string;
  localId: string;
  name: string;
  image?: string;
  set: { id: string; name: string; cardCount?: { official?: number } };
  pricing?: TcgdexPricing | null;
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

// ---- pokemontcg.io ------------------------------------------------------------------

export interface PtcgCard {
  id: string;
  name: string;
  number: string;
  set: { id: string; name: string; ptcgoCode?: string; printedTotal?: number };
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

// ---- one card -----------------------------------------------------------------------

/** What the card databases say about one card today. */
export interface CatalogQuote {
  tcgdexId: string;
  /** pokemontcg.io's id for the card; null when it has none (looked for again after PTCG_RETRY_MS). */
  ptcgId: string | null;
  /** When pokemontcg.io was last searched for the card. */
  ptcgSearchedAt: string | null;
  /** TCGplayer's market price in US$ for the card's printing, and its TCGplayer product. */
  tcgplayer: { usd: number; productId: string | null } | null;
  /** Cardmarket's trend price in euros for the card's printing. */
  cardmarketEur: number | null;
  /** The largest official picture: pokemontcg.io's. */
  image: string | null;
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
      const out = (await (await get(this.fetcher, url, { headers })).json()) as T;
      this.streak[db] = 0;
      return out;
    } catch (err) {
      this.streak[db]++;
      throw err;
    }
  }

  /**
   * Today's prices and picture for the TCGdex card `tcgdexId`. `known` is what an earlier quote
   * found on pokemontcg.io (its id, or that it had none, and when it was searched).
   */
  async quote(tcgdexId: string, want: Printing, known: { ptcgId?: string | null; ptcgSearchedAt?: string | null } = {}, setCode?: string | null): Promise<CatalogQuote> {
    const errors: string[] = [];
    const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
    const td = await this.json<TcgdexCard>('tcgdex', `${TCGDEX}/cards/${encodeURIComponent(tcgdexId)}`);
    let ptcgId = known.ptcgId ?? null;
    let ptcgSearchedAt = known.ptcgSearchedAt ?? null;
    let pc: PtcgCard | null = null;
    const stale = !ptcgSearchedAt || Date.parse(ptcgSearchedAt) < this.now().getTime() - PTCG_RETRY_MS;
    try {
      if (!ptcgId && stale) {
        const q = `name:"${td.name.replace(/["\\]/g, '')}" number:${ownNumber(td.localId) || td.localId}`;
        const found = await this.json<{ data?: PtcgCard[] }>('ptcg', `${PTCG}/cards?q=${encodeURIComponent(q)}&select=id,name,number,set,images,tcgplayer`);
        pc = choosePtcg(found.data ?? [], td, setCode);
        ptcgId = pc?.id ?? null;
        ptcgSearchedAt = this.now().toISOString();
      } else if (ptcgId) {
        pc = (await this.json<{ data?: PtcgCard }>('ptcg', `${PTCG}/cards/${encodeURIComponent(ptcgId)}`)).data ?? null;
      }
    } catch (err) {
      errors.push(`pokemontcg.io: ${msg(err)}`);
    }
    const fromTcgdex = tcgdexTcgplayer(td, want);
    const fromPtcg = pc ? ptcgTcgplayer(pc, want) : null;
    return {
      tcgdexId,
      ptcgId,
      ptcgSearchedAt,
      tcgplayer: fromTcgdex ?? (fromPtcg != null ? { usd: fromPtcg, productId: null } : null),
      cardmarketEur: tcgdexCardmarket(td, want),
      image: pc?.images?.large ?? null,
      name: td.name,
      set: td.set.name,
      number: td.localId,
      errors,
    };
  }
}
