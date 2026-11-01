// Where prices and card images come from, and how the binder asks.
//
// PriceCharting's official API (pricecharting.ts, with the owner's subscription token) gives each
// card's ungraded price, recent eBay sales, and its graded prices. TCGplayer's market price comes from the TCGdex card database (catalog.ts), and what it lacks from
// TCGplayer's own catalog (tcgcsv.ts); pictures from TCGplayer's products and TCGdex. A card is
// priced from all of them, blended (updater.ts). No site's pages are read; the daily run records
// failures instead of stopping.

import { type Fetcher, get, SourceError } from '#infrastructure/http/get.ts';

export type Source = 'pricecharting' | 'tcgplayer';

export interface Candidate {
  source: Source;
  /** The product id: PriceCharting's ("5809512") or TCGplayer's ("517045"). */
  id: string;
  url: string;
  /** Card name as the source shows it, with any variant in brackets: "Pikachu [Holo]". */
  title: string;
  set: string;
  number: string;
  usd: number | null;
  /** Small picture for choosing between candidates. */
  thumb: string | null;
}

export interface Quote {
  usd: number | null;
  /** Largest available image of the card. */
  image: string | null;
  /** What the price site says about the card, for filling in its details (updater.ts). */
  info?: ProductInfo | null;
  /** PriceCharting's graded prices in US$, by grade ("PSA 10", "Grade 9.5"), when it has them. */
  grades?: Record<string, number> | null;
}

/** A product's set, release date (YYYY-MM-DD) and rarity, as the price site lists them. */
export interface ProductInfo {
  set: string | null;
  released: string | null;
  rarity: string | null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "December 1, 2023" → "2023-12-01"; "2023-11-17T00:00:00Z" → "2023-11-17"; anything else → null. */
export function releaseDate(s: unknown): string | null {
  const t = String(s ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(t);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// Asking a site (with retries, a timeout and an honest user agent) is the layers' own
// (src/infrastructure/http/get.ts), shared with the card databases' adapters.
export { type Fetcher, get, ProductGone, Refused, retryAfterMs, retryPolicy, retryWait, SourceError } from '#infrastructure/http/get.ts';

// ---- TCGplayer --------------------------------------------------------------------

/** A TCGplayer product's picture on TCGplayer's image server (the product ids come from TCGdex, catalog.ts). */
export { tcgImage } from '#domain/catalog/tcgplayer.ts';

// ---- Exchange rate ----------------------------------------------------------------

/**
 * The Bank of Canada's daily USD to CAD rate (published each business day around 16:30 ET).
 */
export async function exchangeRates(fetcher: Fetcher): Promise<{ rate: number; date: string }> {
  const res = await get(fetcher, 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1');
  const obs = ((await res.json()) as { observations?: { d: string; FXUSDCAD?: { v: string } }[] }).observations?.[0];
  const rate = Number(obs?.FXUSDCAD?.v);
  if (!obs || !(rate > 0.5 && rate < 5)) throw new SourceError('The Bank of Canada rate was missing or out of range');
  return { rate, date: obs.d };
}
