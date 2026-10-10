import fs from 'node:fs';
import { type Logger, quietLogger } from '../log';
import { type Candidate, type Fetcher, ProductGone, type Quote, Refused, SourceError, get, releaseDate, retryAfterMs, retryWait } from './sources';

// PriceCharting's official Prices API (https://www.pricecharting.com/api-documentation), with the
// owner's subscription token (kept in its own secret file, secrets.ts). Each product has an
// ungraded price (recent eBay sales) and, when the subscription includes them, graded prices.
// PriceCharting allows one call a second and blocks (then revokes) an account that makes more, so
// every call and every retry, from the daily update or a person's search, waits its turn behind
// a guard (PriceCharting below): spacing, a cool-down after "too many requests", a breaker after
// repeated failures, a daily call budget, and a short cache so nothing is asked twice in a row. The token goes in the request body, never in an address that could be
// logged. Its terms: the data is for this binder only, and is purged when the subscription ends
// (updater.ts, purgePriceCharting).

const PC = 'https://www.pricecharting.com';

/** A product's page, for "view" links (the address PriceCharting asks apps to link to). */
export const pcUrl = (id: string) => `${PC}/game/${encodeURIComponent(id)}`;

/** One of PriceCharting's prices for a graded card: its key in the API, label, and the grade it is for. */
interface Grade {
  key: string;
  label: string;
  grade: number;
  /** Only that grader's cards (the 10s are priced per grader). */
  grader?: string;
  /** CGC's Pristine 10 and Beckett's Black Label 10: only for a grade that says so. */
  special?: 'pristine' | 'black';
}
/** PriceCharting's graded prices for cards, as its API names them. */
export const GRADES: readonly Grade[] = [
  { key: 'condition-9-price', label: 'Grade 1', grade: 1 },
  { key: 'condition-10-price', label: 'Grade 2', grade: 2 },
  { key: 'condition-13-price', label: 'Grade 3', grade: 3 },
  { key: 'condition-14-price', label: 'Grade 4', grade: 4 },
  { key: 'condition-15-price', label: 'Grade 5', grade: 5 },
  { key: 'condition-16-price', label: 'Grade 6', grade: 6 },
  { key: 'cib-price', label: 'Grade 7', grade: 7 },
  { key: 'new-price', label: 'Grade 8', grade: 8 },
  { key: 'graded-price', label: 'Grade 9', grade: 9 },
  { key: 'box-only-price', label: 'Grade 9.5', grade: 9.5 },
  { key: 'manual-only-price', label: 'PSA 10', grade: 10, grader: 'PSA' },
  { key: 'bgs-10-price', label: 'BGS 10', grade: 10, grader: 'BGS' },
  { key: 'condition-17-price', label: 'CGC 10', grade: 10, grader: 'CGC' },
  { key: 'condition-18-price', label: 'SGC 10', grade: 10, grader: 'SGC' },
  { key: 'condition-21-price', label: 'TAG 10', grade: 10, grader: 'TAG' },
  { key: 'condition-22-price', label: 'ACE 10', grade: 10, grader: 'ACE' },
  { key: 'condition-19-price', label: 'CGC 10 Pristine', grade: 10, grader: 'CGC', special: 'pristine' },
  { key: 'condition-20-price', label: 'BGS 10 Black Label', grade: 10, grader: 'BGS', special: 'black' },
];

/** A PriceCharting product as the binder uses it: a candidate for matching, with its prices. */
export interface PcProduct extends Candidate {
  /** Graded prices in US$, by label ("PSA 10", "Grade 9"); empty when the subscription has none. */
  grades: Record<string, number>;
  released: string | null;
}

/** Pennies (as the API gives prices) to dollars; a missing or zero price is none. */
const dollars = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) / 100 : null);

/** "Lapras [Reverse Holo] #131" → {title: "Lapras [Reverse Holo]", number: "131"}. */
function splitName(name: string) {
  const m = name.match(/^(.*?)\s*#\s*([A-Za-z0-9-]+)\s*$/);
  return m ? { title: m[1].trim(), number: m[2] } : { title: name.trim(), number: '' };
}

/** One product from /api/product or /api/products. */
export function parseProduct(json: unknown): PcProduct {
  const p = (json ?? {}) as Record<string, unknown>;
  const id = String(p.id ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) throw new SourceError('PriceCharting sent a product without an id');
  const { title, number } = splitName(String(p['product-name'] ?? ''));
  const grades: Record<string, number> = {};
  for (const g of GRADES) {
    const usd = dollars(p[g.key]);
    if (usd != null) grades[g.label] = usd;
  }
  return { source: 'pricecharting', id, url: pcUrl(id), title, set: String(p['console-name'] ?? '').trim(), number, usd: dollars(p['loose-price']), thumb: null, grades, released: releaseDate(p['release-date']) };
}

/** What the update reads from a product: its ungraded price, graded prices and set (PriceCharting's API has no pictures). */
export const quoteOf = (p: PcProduct): Quote => ({ usd: p.usd, image: null, info: { set: p.set || null, released: p.released, rarity: null }, grades: p.grades });

/**
 * PriceCharting's price for a graded card: the price for its grader and grade, or else the nearest
 * grade PriceCharting has (a 10 by another grader before a 9.5, and the lower of two equally near
 * grades). Null for a card that isn't graded, or when PriceCharting has no graded price at all.
 */
export function gradedPrice(grades: Record<string, number> | null | undefined, grader: unknown, gradeText: unknown): { label: string; usd: number; exact: boolean } | null {
  const by = String(grader ?? '').trim().toUpperCase().replace(/^BECKETT$/, 'BGS');
  const text = String(gradeText ?? '').toLowerCase();
  const num = Number(text.match(/\d{1,2}(?:\.\d)?/)?.[0]);
  if (!by || by === 'RAW' || !(num >= 1 && num <= 10)) return null;
  const special = /pristine/.test(text) ? 'pristine' : /black/.test(text) ? 'black' : undefined;
  const priced = GRADES.filter((g) => grades?.[g.label] != null);
  // The grade PriceCharting prices it as: 7 and 7.5 are "Grade 7", 8 and 8.5 "Grade 8"; a 10 is its grader's own.
  const own = (g: Grade) =>
    num >= 10 ? g.grade === 10 && g.grader === by && g.special === (special && g.grader === by ? special : undefined) : g.grade === (num >= 7 && num < 9 ? Math.floor(num) : num) && !g.grader;
  const exact = priced.find(own);
  if (exact) return { label: exact.label, usd: grades![exact.label], exact: true };
  // Pristine and Black Label 10s are worth more than a plain 10: never another card's price.
  const near = priced
    .filter((g) => !g.special || (g.special === special && g.grader === by))
    .map((g) => ({ g, d: Math.abs(g.grade - num), rank: g.grader === by ? 0 : g.grader === 'PSA' ? 1 : g.grader ? 2 : 0 }))
    .sort((a, b) => a.d - b.d || a.rank - b.rank || a.g.grade - b.g.grade);
  const hit = near[0]?.g;
  return hit ? { label: hit.label, usd: grades![hit.label], exact: false } : null;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * A product address saved when the binder read PriceCharting's pages
 * ("/game/pokemon-scarlet-&amp;-violet-151/lapras-131"), as words to search the API for, and a
 * test for the product it named. Null for an API product id.
 */
export function oldAddress(id: string): { query: string; is: (p: Candidate) => boolean } | null {
  const raw = id.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#43;/g, '+');
  const m = /^\/game\/([^/?#\s]+)\/([^/?#\s]+)$/.exec(raw);
  if (!m) return null;
  const part = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const [set, product] = [part(m[1]), part(m[2])];
  return {
    query: `${product.replace(/-/g, ' ')} ${set.replace(/-/g, ' ')}`.replace(/\s+/g, ' ').trim(),
    is: (p) => fold(p.set) === fold(set) && fold(`${p.title}${p.number}`) === fold(product),
  };
}

/** The token is missing: PriceCharting isn't asked. */
export class NoToken extends SourceError {}
/**
 * PriceCharting isn't being asked for now: it said too many requests (a cool-down), it kept
 * failing (the circuit breaker), or today's call budget is spent. A Refused, so a running update
 * stops asking it and prices from the other sources meanwhile.
 */
export class Paused extends Refused {}

/** What PriceCharting's API allows (https://www.pricecharting.com/api-documentation#api-limits). */
export const PC_RULES = {
  /** "The API is limited to 1 call every second. Any more than that and your calls will be blocked and your account permissions revoked." */
  minGapMs: 1000,
  /** Our spacing: a quarter of a second more, for clocks and networks that aren't exact. */
  gapMs: 1250,
  /** After a 429 (too many requests): no calls for at least this long, or as long as its Retry-After asks. */
  coolDownMs: 10 * 60_000,
  /** Calls that fail in a row (after their retries) before the breaker stops all calls for breakerMs. */
  breakerAfter: 5,
  breakerMs: 10 * 60_000,
  /** Answers kept and reused for this long, so the same product or search isn't asked twice in a row. */
  cacheMs: 10 * 60_000,
  /** Calls a day, so a runaway loop can't make thousands (a 122-card binder needs about 250). */
  dailyLimit: 2000,
  /** Tries per call (only busy or unreachable answers are tried again), and how long one call may take in all. */
  attempts: 3,
  deadlineMs: 90_000,
};

export interface PriceChartingOptions {
  /** The saved token, or null (read on every call, so a new one is used at once). */
  token: () => string | null;
  fetcher?: Fetcher;
  /** Least time between two calls, retries included (PriceCharting allows one a second). */
  gapMs?: number;
  /** Calls allowed a day (PRICECHARTING_DAILY_LIMIT). */
  dailyLimit?: number;
  /** Where the day's call count is kept, so a restart doesn't reset it. */
  usageFile?: string;
  log?: Logger;
  now?: () => number;
  /** Cool-down after a 429, breaker and cache times (the tests shorten them). */
  coolDownMs?: number;
  breakerMs?: number;
  cacheMs?: number;
}

/** How PriceCharting is being used: shown under Administration → Prices. */
export interface PcUsage {
  day: string;
  calls: number;
  limit: number;
  gapMs: number;
  /** Why it isn't being asked, and until when (a cool-down, the breaker or the budget). */
  pausedUntil: string | null;
  pausedWhy: string | null;
  failuresInARow: number;
  lastCallAt: string | null;
  cached: number;
}

const BUSY = [408, 425, 429, 500, 502, 503, 504];

export class PriceCharting {
  private readonly fetcher: Fetcher;
  private readonly gapMs: number;
  private readonly limit: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly coolDownMs: number;
  private readonly breakerMs: number;
  private readonly cacheMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** When the last request (any attempt) ended. */
  private last = 0;
  private usage: { day: string; calls: number; warned: boolean };
  private paused: { until: number; why: string } | null = null;
  private failures = 0;
  private readonly cache = new Map<string, { at: number; body: Record<string, unknown> }>();
  /** Calls made, for the tests and the logs. */
  calls = 0;

  constructor(private readonly o: PriceChartingOptions) {
    this.fetcher = o.fetcher ?? fetch;
    // Never closer together than PriceCharting allows, whatever is asked.
    this.gapMs = Math.max(o.gapMs ?? PC_RULES.gapMs, o.gapMs === 0 ? 0 : PC_RULES.minGapMs);
    this.limit = o.dailyLimit && o.dailyLimit > 0 ? o.dailyLimit : PC_RULES.dailyLimit;
    this.log = o.log ?? quietLogger();
    this.now = o.now ?? Date.now;
    this.coolDownMs = o.coolDownMs ?? PC_RULES.coolDownMs;
    this.breakerMs = o.breakerMs ?? PC_RULES.breakerMs;
    this.cacheMs = o.cacheMs ?? PC_RULES.cacheMs;
    this.usage = { day: this.day(), calls: 0, warned: false };
    if (o.usageFile) {
      try {
        const saved = JSON.parse(fs.readFileSync(o.usageFile, 'utf8')) as { day?: string; calls?: number; pausedUntil?: number; pausedWhy?: string };
        if (saved.day === this.usage.day && Number.isFinite(saved.calls)) this.usage.calls = Number(saved.calls);
        // A cool-down outlasts a restart: PriceCharting still counts it.
        if (Number(saved.pausedUntil) > this.now()) this.paused = { until: Number(saved.pausedUntil), why: String(saved.pausedWhy ?? 'PriceCharting asked us to slow down.') };
      } catch {
        // none yet, or unreadable: start counting from zero
      }
    }
  }

  /** Whether a token is saved. */
  get ready() {
    return !!this.o.token();
  }

  private day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Why PriceCharting isn't being asked right now, or null. */
  out(): string | null {
    if (this.paused && this.paused.until > this.now()) return this.paused.why;
    if (this.usage.day === this.day() && this.usage.calls >= this.limit) return `PriceCharting's daily call budget (${this.limit}) is spent; it's asked again tomorrow.`;
    return null;
  }

  usageNow(): PcUsage {
    const day = this.day();
    const paused = this.paused && this.paused.until > this.now() ? this.paused : null;
    const spent = this.usage.day === day && this.usage.calls >= this.limit;
    return {
      day,
      calls: this.usage.day === day ? this.usage.calls : 0,
      limit: this.limit,
      gapMs: this.gapMs,
      pausedUntil: paused ? new Date(paused.until).toISOString() : spent ? `${day}T23:59:59.999Z` : null,
      pausedWhy: paused ? paused.why : spent ? this.out() : null,
      failuresInARow: this.failures,
      lastCallAt: this.last ? new Date(this.last).toISOString() : null,
      cached: this.cache.size,
    };
  }

  /** Forget every answer kept (the token was removed, or PriceCharting's data purged). */
  forget() {
    this.cache.clear();
  }

  private saveUsage() {
    if (!this.o.usageFile) return;
    try {
      const tmp = `${this.o.usageFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ day: this.usage.day, calls: this.usage.calls, ...(this.paused ? { pausedUntil: this.paused.until, pausedWhy: this.paused.why } : {}) }));
      fs.renameSync(tmp, this.o.usageFile);
    } catch (err) {
      this.log.warn('pricing', `Couldn't save PriceCharting's call count: ${err instanceof Error ? err.message : err}`);
    }
  }

  private pause(ms: number, why: string, level: 'warn' | 'error') {
    const until = this.now() + ms;
    if (this.paused && this.paused.until >= until) return;
    this.paused = { until, why };
    this.log[level]('pricing', `${why} PriceCharting isn't asked again until ${new Date(until).toISOString()}.`, { minutes: Math.round(ms / 60_000) });
    this.saveUsage();
  }

  /** Wait for PriceCharting's turn: at least gapMs after the last request ended, and only when it isn't paused or out of budget. */
  private async turn() {
    const out = this.out();
    if (out) throw new Paused(out);
    const day = this.day();
    if (this.usage.day !== day) this.usage = { day, calls: 0, warned: false };
    const wait = this.last + this.gapMs - this.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.usage.calls++;
    this.calls++;
    if (!this.usage.warned && this.usage.calls >= Math.ceil(this.limit * 0.8)) {
      this.usage.warned = true;
      this.log.warn('pricing', `PriceCharting: ${this.usage.calls} of today's ${this.limit} calls made`, { calls: this.usage.calls, limit: this.limit });
    }
    if (this.usage.calls === this.limit) this.log.error('pricing', `PriceCharting's daily call budget (${this.limit}) is spent; it isn't asked again until tomorrow (UTC). Raise PRICECHARTING_DAILY_LIMIT if the binder really needs more.`, { limit: this.limit });
    this.saveUsage();
  }

  /**
   * One API call: after the ones before it (one at a time), each attempt at least gapMs after the
   * last. A busy or unreachable PriceCharting is tried again (backoff, its Retry-After, an overall
   * time limit); a 429 pauses every call for a cool-down; failures in a row open the breaker.
   * Answers that won't change (400, 401, 403, 404) aren't tried again.
   */
  private call(path: string, params: Record<string, string>, token = this.o.token(), cacheable = true): Promise<Record<string, unknown>> {
    const key = cacheable ? `${path}?${new URLSearchParams(params)}` : '';
    const hit = key ? this.cache.get(key) : undefined;
    if (hit && this.now() - hit.at < this.cacheMs) return Promise.resolve(structuredClone(hit.body));
    const run = async () => {
      if (!token) throw new NoToken('PriceCharting has no API token: add it under Administration → Prices.');
      const started = this.now();
      for (let attempt = 0; ; attempt++) {
        await this.turn();
        let res: Response;
        try {
          res = await get(
            this.fetcher,
            PC + path,
            { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ t: token, ...params }).toString() },
            { attempts: 1, allow: [400, 401, 403, 404, ...BUSY] },
          );
        } catch (err) {
          // Unreachable (or timed out): tried again unless that's the last try.
          this.last = this.now();
          const wait = retryWait(attempt, null);
          if (attempt + 1 < PC_RULES.attempts && this.now() + wait - started < PC_RULES.deadlineMs) {
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw this.failed(err instanceof SourceError ? err : new SourceError(String(err)));
        }
        this.last = this.now();
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (res.ok && body?.status === 'success') {
          this.failures = 0;
          if (key) {
            this.cache.set(key, { at: this.now(), body });
            if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
          }
          return structuredClone(body);
        }
        const why = String(body?.['error-message'] ?? body?.error ?? '').slice(0, 200);
        if (res.status === 429) {
          // Too many requests: stop every call for a while, rather than risk the account.
          const asked = retryAfterMs(res.headers.get('retry-after'));
          this.pause(Math.max(this.coolDownMs, asked ?? 0), `PriceCharting said too many requests (429)${why ? `: ${why}` : ''}.`, 'error');
          throw new Paused(this.paused!.why);
        }
        if (BUSY.includes(res.status)) {
          const wait = retryWait(attempt, res.headers.get('retry-after'));
          if (attempt + 1 < PC_RULES.attempts && this.now() + wait - started < PC_RULES.deadlineMs) {
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw this.failed(new SourceError(`PriceCharting answered ${res.status}${why ? `: ${why}` : ''}`));
        }
        this.failures = 0;
        if (res.status === 401 || res.status === 403) throw new Refused(/token/i.test(why) ? "PriceCharting didn't accept the API token: check it under Administration → Prices." : `PriceCharting refused the request (${res.status})${why ? `: ${why}` : ''}.`);
        if (res.status === 404 || /no such product/i.test(why)) throw new ProductGone(`PriceCharting has no product ${params.id ?? 'like that'} any more.`);
        throw new SourceError(`PriceCharting answered ${res.status}${why ? `: ${why}` : ''}`);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** A call that failed after its tries: counted toward the breaker. */
  private failed(err: SourceError): SourceError {
    if (++this.failures >= PC_RULES.breakerAfter) {
      this.pause(this.breakerMs, `PriceCharting failed ${this.failures} times in a row (${err.message}).`, 'error');
      this.failures = 0;
    }
    return err;
  }

  /** Up to 20 products for a search ("Lapras 131"), best first. */
  async search(q: string): Promise<PcProduct[]> {
    const body = await this.call('/api/products', { q });
    const list = Array.isArray(body.products) ? body.products : [];
    return list.flatMap((p) => {
      try {
        return [parseProduct(p)];
      } catch {
        return [];
      }
    });
  }

  /** One product by its id, with all its prices. */
  async product(id: string): Promise<PcProduct> {
    if (!/^\d{1,12}$/.test(id)) throw new SourceError(`Not a PriceCharting product id: ${id}`);
    return parseProduct(await this.call('/api/product', { id }));
  }

  /** The API product a link saved from PriceCharting's pages named, or null if it can't be found. */
  async fromAddress(address: string): Promise<PcProduct | null> {
    const old = oldAddress(address);
    if (!old) return null;
    const found = (await this.search(old.query)).filter(old.is);
    return found.length === 1 ? this.product(found[0].id) : null;
  }

  /** Whether PriceCharting accepts a token (one call, never from the cache), before it's saved. */
  async check(token: string): Promise<void> {
    await this.call('/api/products', { q: 'charizard 4 base set' }, token, false);
  }
}
