// Where prices and card images come from, and how the binder asks.
//
// PriceCharting's official API (pricecharting.ts, with the owner's subscription token) gives each
// card's ungraded price, recent eBay sales, and its graded prices. TCGplayer's market price and
// Cardmarket's trend come from the TCGdex card database, and the largest pictures from
// pokemontcg.io (catalog.ts). A card is priced from all of them and the highest is logged
// (updater.ts). No site's pages are read; the daily run records failures instead of stopping.

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

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const UA = 'Mozilla/5.0 (compatible; PokemonBinderLedger/1.0; personal collection tracker)';
const TIMEOUT_MS = 20_000;

export class SourceError extends Error {}
/** The product no longer exists on the site (PriceCharting answers "No such product"): the card is matched again. */
export class ProductGone extends SourceError {}
/** The site refuses our requests (401 or 403), as PriceCharting does a token it doesn't know: the update stops asking it. */
export class Refused extends SourceError {}

/**
 * How often a busy or unreachable site is retried: after baseMs, then twice as long each time
 * (2 s, 4 s …), with a little random spread, or as long as the site's Retry-After asks (up to
 * maxMs); never past deadlineMs from the first try.
 */
export const retryPolicy = { attempts: 3, baseMs: 2000, maxMs: 60_000, deadlineMs: 90_000 };

/** Answers that mean "busy, try again later"; every other answer is final. */
const BUSY = new Set([408, 425, 429, 500, 502, 503, 504]);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Retry-After header in milliseconds: seconds ("120") or a date ("Wed, 21 Oct 2026 07:28:00 GMT"); null when missing or nonsense. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | null {
  const h = String(header ?? '').trim();
  if (!h) return null;
  if (/^\d+$/.test(h)) return Number(h) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/**
 * How long to wait before try number attempt+2: the site's Retry-After, or exponential backoff with
 * jitter; at most maxMs. A site asking for longer than maxMs gets Infinity: it isn't tried again
 * now (retrying sooner than it asked would ignore it).
 */
export function retryWait(attempt: number, retryAfter: string | null): number {
  const asked = retryAfterMs(retryAfter);
  if (asked != null && asked > retryPolicy.maxMs) return Infinity;
  const ms = asked != null && asked > 0 ? asked : retryPolicy.baseMs * 2 ** attempt;
  return Math.min(retryPolicy.maxMs, ms) * (1 + Math.random() * 0.25);
}

/**
 * fetch with a timeout, an honest user agent, and retries with exponential backoff when the site is
 * busy or unreachable (never for an answer that won't change: 400, 401, 403, 404). `patience`
 * shortens both for a source that's only nice to have; `allow` hands those statuses back instead
 * of throwing (PriceCharting reads its own error answers).
 */
export async function get(fetcher: Fetcher, url: string, init: RequestInit = {}, patience: { timeoutMs?: number; attempts?: number; allow?: number[] } = {}): Promise<Response> {
  const host = new URL(url).host;
  const attempts = Math.max(1, Math.min(patience.attempts ?? retryPolicy.attempts, retryPolicy.attempts));
  const started = Date.now();
  // Another try only if it fits before the deadline.
  const again = (attempt: number, wait: number) => attempt + 1 < attempts && Date.now() + wait - started < retryPolicy.deadlineMs;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetcher(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(patience.timeoutMs ?? TIMEOUT_MS) });
    } catch (err) {
      const wait = retryWait(attempt, null);
      if (again(attempt, wait)) {
        await pause(wait);
        continue;
      }
      throw new SourceError(`Couldn't reach ${host}: ${err instanceof Error ? err.message : err}`);
    }
    if (BUSY.has(res.status) && !patience.allow?.includes(res.status)) {
      const wait = retryWait(attempt, res.headers.get('retry-after'));
      if (again(attempt, wait)) {
        await res.body?.cancel().catch(() => {});
        await pause(wait);
        continue;
      }
    }
    if (patience.allow?.includes(res.status)) return res;
    if (res.status === 401 || res.status === 403) throw new Refused(`${host} refused the request (${res.status})`);
    if (!res.ok) throw new SourceError(`${host} answered ${res.status}`);
    return res;
  }
}

// ---- TCGplayer --------------------------------------------------------------------

/** A TCGplayer product's picture on TCGplayer's image server (the product ids come from TCGdex, catalog.ts). */
export const tcgImage = (id: string | number, size: 200 | 1000) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_${size}x${size}.jpg`;

// ---- Exchange rate ----------------------------------------------------------------

/**
 * The Bank of Canada's daily USD to CAD and EUR to CAD rates (published each business day around
 * 16:30 ET). The euro rate (for Cardmarket's prices) is null if it's missing.
 */
export async function exchangeRates(fetcher: Fetcher): Promise<{ rate: number; eur: number | null; date: string }> {
  const res = await get(fetcher, 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXEURCAD/json?recent=1');
  const obs = ((await res.json()) as { observations?: { d: string; FXUSDCAD?: { v: string }; FXEURCAD?: { v: string } }[] }).observations?.[0];
  const rate = Number(obs?.FXUSDCAD?.v);
  if (!obs || !(rate > 0.5 && rate < 5)) throw new SourceError('The Bank of Canada rate was missing or out of range');
  const eur = Number(obs.FXEURCAD?.v);
  return { rate, eur: eur > 0.5 && eur < 5 ? eur : null, date: obs.d };
}
