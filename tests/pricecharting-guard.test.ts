import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '../server/log';
import { Paused, PC_RULES, PriceCharting } from '../server/pricing/pricecharting';
import { type Fetcher, ProductGone, Refused, get, retryAfterMs, retryPolicy } from '../server/pricing/sources';

// PriceCharting's API rules (https://www.pricecharting.com/api-documentation#api-limits): one call
// a second, or calls are blocked and the account revoked. The guard keeps every call and retry to
// that, pauses after "too many requests", stops after repeated failures, keeps a daily budget and
// reuses recent answers.

retryPolicy.baseMs = 1;
const PRODUCT = { status: 'success', id: '100', 'product-name': 'Lapras #131', 'console-name': 'Pokemon 30th Celebration', 'loose-price': 1320 };

let dir: string;
let clock: number;
let log: Logger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-pc-'));
  clock = Date.parse('2026-10-03T12:00:00Z');
  log = new Logger({ stdout: false, now: () => new Date(clock) });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A PriceCharting that answers from `answer` (a status, or a Response), recording when each request came. */
function net(answer: (n: number) => number | Response = () => 200) {
  const at: number[] = [];
  const fetcher: Fetcher = async () => {
    at.push(Date.now());
    const a = answer(at.length);
    if (a instanceof Response) return a;
    return a === 200 ? Response.json(PRODUCT) : Response.json({ status: 'error', 'error-message': `answered ${a}` }, { status: a });
  };
  return { fetcher, at };
}
const pc = (n: ReturnType<typeof net>, o: Partial<ConstructorParameters<typeof PriceCharting>[0]> = {}) =>
  new PriceCharting({ token: () => 'test-token', fetcher: n.fetcher, gapMs: 0, log, now: () => clock, usageFile: path.join(dir, 'usage.json'), ...o });

describe('PriceCharting’s one call a second', () => {
  it('spaces every request, retries included, at least a second apart', async () => {
    // The first answer is busy (retried), then two more calls.
    const n = net((i) => (i === 1 ? 503 : 200));
    const api = new PriceCharting({ token: () => 'test-token', fetcher: n.fetcher, log, cacheMs: 0 });
    await api.product('100');
    await api.product('100');
    expect(n.at).toHaveLength(3);
    for (let i = 1; i < n.at.length; i++) expect(n.at[i] - n.at[i - 1]).toBeGreaterThanOrEqual(PC_RULES.minGapMs);
    // Asking for less spacing than PriceCharting allows gets the minimum.
    expect(new PriceCharting({ token: () => 't', gapMs: 200 }).usageNow().gapMs).toBe(PC_RULES.minGapMs);
    expect(new PriceCharting({ token: () => 't' }).usageNow().gapMs).toBe(PC_RULES.gapMs);
  }, 10_000);
});

describe('when PriceCharting says too many requests', () => {
  it('stops every call for a cool-down (or its Retry-After), even across a restart', async () => {
    const n = net((i) => (i === 1 ? new Response(JSON.stringify({ status: 'error', 'error-message': 'Rate limit' }), { status: 429, headers: { 'Retry-After': '1800' } }) : 200));
    const api = pc(n);
    await expect(api.product('100')).rejects.toBeInstanceOf(Paused);
    expect(n.at).toHaveLength(1); // not retried
    expect(log.query({ level: 'error' })[0].msg).toMatch(/^PriceCharting said too many requests \(429\): Rate limit\. PriceCharting isn't asked again until 2026-10-03T12:30:00\.000Z/);
    await expect(api.search('Lapras')).rejects.toThrow(/too many requests/);
    expect(n.at).toHaveLength(1);
    expect(api.out()).toMatch(/too many requests/);
    expect(api.usageNow()).toMatchObject({ pausedUntil: '2026-10-03T12:30:00.000Z', calls: 1 });
    // The next server remembers it.
    const next = pc(n);
    expect(next.out()).toMatch(/too many requests/);
    clock += 31 * 60_000;
    expect(next.out()).toBeNull();
    await expect(next.product('100')).resolves.toMatchObject({ id: '100', usd: 13.2 });
  });

  it('a 429 without Retry-After still waits the whole cool-down', async () => {
    const api = pc(net(() => 429));
    await expect(api.product('100')).rejects.toBeInstanceOf(Paused);
    expect(api.usageNow().pausedUntil).toBe(new Date(clock + PC_RULES.coolDownMs).toISOString());
  });
});

describe('PriceCharting failing', () => {
  it('retries a busy answer, then opens the breaker after failures in a row', async () => {
    const n = net(() => 503);
    const api = pc(n, { breakerMs: 60_000 });
    for (let i = 0; i < PC_RULES.breakerAfter; i++) await expect(api.product('100')).rejects.toThrow(/PriceCharting answered 503/);
    expect(n.at).toHaveLength(PC_RULES.breakerAfter * PC_RULES.attempts);
    expect(api.out()).toMatch(/PriceCharting failed 5 times in a row \(PriceCharting answered 503: answered 503\)/);
    await expect(api.product('100')).rejects.toBeInstanceOf(Paused);
    expect(n.at).toHaveLength(PC_RULES.breakerAfter * PC_RULES.attempts);
    expect(log.query({ level: 'error', text: 'failed 5 times in a row' })).toHaveLength(1);
    clock += 61_000;
    expect(api.out()).toBeNull();
  });

  it('a success resets the count; an unreachable PriceCharting is retried too', async () => {
    let down = true;
    const fetcher: Fetcher = async () => {
      if (down) throw new TypeError('fetch failed');
      return Response.json(PRODUCT);
    };
    const api = new PriceCharting({ token: () => 't', fetcher, gapMs: 0, log, now: () => clock });
    await expect(api.product('100')).rejects.toThrow(/Couldn't reach www\.pricecharting\.com: fetch failed/);
    expect(api.usageNow()).toMatchObject({ failuresInARow: 1, calls: PC_RULES.attempts });
    down = false;
    await api.product('100');
    expect(api.usageNow().failuresInARow).toBe(0);
  });

  it('never retries answers that won’t change', async () => {
    for (const [status, err] of [[404, ProductGone], [401, Refused], [403, Refused], [400, Error]] as const) {
      const n = net(() => status);
      await expect(pc(n).product('100')).rejects.toBeInstanceOf(err);
      expect(n.at).toHaveLength(1);
    }
  });
});

describe('PriceCharting’s daily call budget', () => {
  it('warns at 80%, stops at the limit, counts across a restart and starts again the next day', async () => {
    const n = net();
    const api = pc(n, { dailyLimit: 5, cacheMs: 0 });
    for (let i = 0; i < 4; i++) await api.product('100');
    expect(log.query({ level: 'warn', text: 'of today' })[0].msg).toBe("PriceCharting: 4 of today's 5 calls made");
    const next = pc(n, { dailyLimit: 5, cacheMs: 0 }); // a restart
    expect(next.usageNow().calls).toBe(4);
    await next.product('100');
    expect(log.query({ level: 'error', text: 'budget' })[0].msg).toMatch(/^PriceCharting's daily call budget \(5\) is spent/);
    await expect(next.product('100')).rejects.toBeInstanceOf(Paused);
    expect(n.at).toHaveLength(5);
    expect(next.usageNow()).toMatchObject({ calls: 5, limit: 5, pausedWhy: expect.stringMatching(/budget/) });
    clock += 86_400_000;
    await next.product('100');
    expect(next.usageNow().calls).toBe(1);
  });
});

describe('reusing recent answers', () => {
  it('asks once for the same product or search within ten minutes; never for a token check; nothing kept after a purge', async () => {
    const n = net();
    const api = pc(n);
    const a = await api.product('100');
    a.title = 'changed by the caller';
    expect((await api.product('100')).title).toBe('Lapras');
    expect(n.at).toHaveLength(1);
    await api.check('another-token');
    await api.check('another-token');
    expect(n.at).toHaveLength(3);
    clock += PC_RULES.cacheMs + 1;
    await api.product('100');
    expect(n.at).toHaveLength(4);
    api.forget();
    expect(api.usageNow().cached).toBe(0);
  });
});

describe('retrying the other sites', () => {
  it('reads Retry-After in seconds or as a date', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs('Sat, 03 Oct 2026 12:01:00 GMT', Date.parse('2026-10-03T12:00:00Z'))).toBe(60_000);
    expect(retryAfterMs('Sat, 03 Oct 2026 11:00:00 GMT', Date.parse('2026-10-03T12:00:00Z'))).toBe(0);
    expect(retryAfterMs('soon')).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });

  it('retries busy answers, not final ones, and gives up at the deadline', async () => {
    let calls = 0;
    const busy: Fetcher = async () => (calls++, new Response('busy', { status: 503 }));
    await expect(get(busy, 'https://api.tcgdex.net/x')).rejects.toThrow('api.tcgdex.net answered 503');
    expect(calls).toBe(retryPolicy.attempts);
    calls = 0;
    const gone: Fetcher = async () => (calls++, new Response('no', { status: 404 }));
    await expect(get(gone, 'https://api.tcgdex.net/x')).rejects.toThrow('answered 404');
    expect(calls).toBe(1);
    // A Retry-After past the deadline: not waited for.
    calls = 0;
    const later: Fetcher = async () => (calls++, new Response('busy', { status: 503, headers: { 'Retry-After': '3600' } }));
    const t = Date.now();
    await expect(get(later, 'https://api.tcgdex.net/x')).rejects.toThrow('answered 503');
    expect(calls).toBe(1);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('the price update and a paused PriceCharting', () => {
  it('doesn’t ask PriceCharting while it’s paused, and says why', async () => {
    const { PriceUpdater } = await import('../server/pricing/updater');
    const { Store } = await import('../server/store');
    const { Assets } = await import('../server/assets');
    const n = net(() => 429);
    const api = pc(n);
    await expect(api.product('100')).rejects.toBeInstanceOf(Paused);
    const u = new PriceUpdater({ store: new Store(dir), assets: new Assets(dir), fetcher: n.fetcher, now: () => new Date(clock), delayMs: 0, pricecharting: api });
    expect(u.siteOut('pricecharting')).toMatch(/^PriceCharting said too many requests \(429\).*TCGplayer and Cardmarket give prices meanwhile\.$/);
    expect(u.siteOut('tcgplayer')).toBeNull();
  });
});
