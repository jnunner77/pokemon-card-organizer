import { SourceUnavailable } from '#application/catalog/ports.ts';

// Asking another site for something (the card databases, the price sites, the exchange rate):
// fetch with a timeout, an honest user agent, and retries when the site is busy or unreachable.

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const UA = 'Mozilla/5.0 (compatible; PokemonBinderLedger/1.0; personal collection tracker)';
const TIMEOUT_MS = 20_000;

/** A site didn't answer, or answered with an error (its status, when it answered). */
export class SourceError extends SourceUnavailable {}
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

export interface Patience {
  readonly timeoutMs?: number | undefined;
  readonly attempts?: number | undefined;
  readonly maxWaitMs?: number | undefined;
  readonly allow?: readonly number[] | undefined;
}

/**
 * fetch with a timeout, an honest user agent, and retries with exponential backoff when the site is
 * busy or unreachable (never for an answer that won't change: 400, 401, 403, 404). `patience`
 * shortens both for a source that's only nice to have, and `maxWaitMs` gives up rather than wait
 * longer for a retry (a page asking for a minute's wait: the update moves on and the card is tried
 * again next time); `allow` hands those statuses back instead of throwing (PriceCharting
 * reads its own error answers).
 */
export async function get(fetcher: Fetcher, url: string, init: RequestInit = {}, patience: Patience = {}): Promise<Response> {
  const host = new URL(url).host;
  const attempts = Math.max(1, Math.min(patience.attempts ?? retryPolicy.attempts, retryPolicy.attempts));
  const started = Date.now();
  // Another try only if it fits before the deadline.
  const again = (attempt: number, wait: number) => attempt + 1 < attempts && wait <= (patience.maxWaitMs ?? Infinity) && Date.now() + wait - started < retryPolicy.deadlineMs;
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
      throw new SourceError(`Couldn't reach ${host}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (BUSY.has(res.status) && !patience.allow?.includes(res.status)) {
      const wait = retryWait(attempt, res.headers.get('retry-after'));
      if (again(attempt, wait)) {
        await res.body?.cancel().catch(() => undefined);
        await pause(wait);
        continue;
      }
    }
    if (patience.allow?.includes(res.status)) return res;
    if (res.status === 401 || res.status === 403) throw new Refused(`${host} refused the request (${res.status})`, res.status);
    if (!res.ok) throw new SourceError(`${host} answered ${res.status}`, res.status);
    return res;
  }
}
