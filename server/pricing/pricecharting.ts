import { type Candidate, type Fetcher, ProductGone, type Quote, Refused, SourceError, get, releaseDate } from './sources';

// PriceCharting's official Prices API (https://www.pricecharting.com/api-documentation), with the
// owner's subscription token (kept in its own secret file, secrets.ts). Each product has an
// ungraded price (recent eBay sales) and, when the subscription includes them, graded prices.
// PriceCharting allows one call a second, so every call, from the daily update or a person's
// search, waits its turn. The token goes in the request body, never in an address that could be
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

export interface PriceChartingOptions {
  /** The saved token, or null (read on every call, so a new one is used at once). */
  token: () => string | null;
  fetcher?: Fetcher;
  /** Least time between two calls: PriceCharting allows one a second. */
  gapMs?: number;
}

export class PriceCharting {
  private readonly fetcher: Fetcher;
  private readonly gapMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  /** Calls made, for the tests and the logs. */
  calls = 0;

  constructor(private readonly o: PriceChartingOptions) {
    this.fetcher = o.fetcher ?? fetch;
    this.gapMs = o.gapMs ?? 1100;
  }

  /** Whether a token is saved. */
  get ready() {
    return !!this.o.token();
  }

  /** One API call, after the ones before it and at least gapMs after the last. */
  private call(path: string, params: Record<string, string>, token = this.o.token()): Promise<Record<string, unknown>> {
    const run = async () => {
      if (!token) throw new NoToken('PriceCharting has no API token: add it under Administration → Prices.');
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.calls++;
      try {
        const res = await get(
          this.fetcher,
          PC + path,
          { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ t: token, ...params }).toString() },
          { allow: [400, 401, 403, 404] },
        );
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (res.ok && body?.status === 'success') return body;
        const why = String(body?.['error-message'] ?? body?.error ?? '').slice(0, 200);
        if (res.status === 401 || res.status === 403) throw new Refused(/token/i.test(why) ? "PriceCharting didn't accept the API token: check it under Administration → Prices." : `PriceCharting refused the request (${res.status})${why ? `: ${why}` : ''}.`);
        if (res.status === 404 || /no such product/i.test(why)) throw new ProductGone(`PriceCharting has no product ${params.id ?? 'like that'} any more.`);
        throw new SourceError(`PriceCharting answered ${res.status}${why ? `: ${why}` : ''}`);
      } finally {
        this.last = Date.now();
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
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

  /** Whether PriceCharting accepts a token (one call), before it's saved. */
  async check(token: string): Promise<void> {
    await this.call('/api/products', { q: 'charizard 4 base set' }, token);
  }
}
