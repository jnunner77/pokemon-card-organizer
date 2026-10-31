import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/bulk.js is a plain browser script; load it the way the page does.
type Failure = { id: string; error: (Error & { code?: string }) | null };
interface BinderBulk {
  run(ids: string[], save: (id: string) => Promise<unknown>, opts?: Record<string, unknown>): Promise<{ saved: string[]; failed: Failure[]; stopped: (Error & { code?: string }) | null }>;
  progressText(settled: number, total: number): string;
  partialText(saved: number, total: number, failed: number, error?: { message?: string } | null): string;
}
const sandbox = { window: {} as { BinderBulk: BinderBulk } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/bulk.js'), 'utf8'), sandbox);
const B = sandbox.window.BinderBulk;

const clock = () => {
  const c = { t: 0, waits: [] as number[] };
  return { c, now: () => c.t, sleep: (ms: number) => { c.waits.push(ms); c.t += ms; return Promise.resolve(); } };
};
const problem = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${code} happened`), { code }, extra);
const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i + 1}`);

describe('saving many cards', () => {
  it('saves every card, reporting progress, never more than the limit at once', async () => {
    const k = clock();
    let live = 0, peak = 0;
    const progress: number[] = [];
    const r = await B.run(ids(10), async () => { live++; peak = Math.max(peak, live); await new Promise((ok) => setTimeout(ok, 1)); live--; }, { ...k, concurrency: 3, onProgress: (n: number, t: number) => { expect(t).toBe(10); progress.push(n); } });
    expect(r).toEqual({ saved: ids(10), failed: [], stopped: null });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('fails only the card the server refused, keeping ids in order', async () => {
    const r = await B.run(ids(5), async (id) => { if (id === 'c3') throw problem('invalid_argument'); }, clock());
    expect(r.saved).toEqual(['c1', 'c2', 'c4', 'c5']);
    expect(r.failed.map((f) => [f.id, f.error?.code])).toEqual([['c3', 'invalid_argument']]);
    expect(r.stopped).toBeNull();
  });

  it('waits as long as the server says on rate_limited, then saves', async () => {
    const k = clock();
    let first = true;
    const r = await B.run(['a'], async () => { if (first) { first = false; throw problem('rate_limited', { retryAfter: 2 }); } }, k);
    expect(r.saved).toEqual(['a']);
    expect(k.c.waits).toEqual([2000]);
  });

  it('keeps waiting while the server keeps saying wait: a rate-limited card is never given up on', async () => {
    const k = clock();
    let limited = 8;
    const r = await B.run(['a'], async () => { if (limited-- > 0) throw problem('rate_limited', { retryAfter: 1 }); }, k);
    expect(r.saved).toEqual(['a']);
    expect(r.failed).toEqual([]);
    expect(k.c.waits.length).toBe(8);
  });

  it('waits a second without a Retry-After, and spaces later requests out', async () => {
    const k = clock();
    const starts: number[] = [];
    let limited = true;
    const r = await B.run(ids(4), async () => { starts.push(k.c.t); if (limited) { limited = false; throw problem('rate_limited'); } }, { ...k, concurrency: 1 });
    expect(r.saved).toEqual(ids(4));
    expect(k.c.waits[0]).toBe(1000);
    const after = starts.slice(2);
    for (let i = 1; i < after.length; i++) expect(after[i] - after[i - 1]).toBeGreaterThanOrEqual(260);
  });

  it('retries an unreachable server with growing waits, then gives up on the card', async () => {
    const k = clock();
    let calls = 0;
    const r = await B.run(['a'], async () => { calls++; throw problem('unavailable'); }, k);
    expect(calls).toBe(5);
    expect(k.c.waits).toEqual([500, 1000, 2000, 4000]);
    expect(r.failed.map((f) => f.id)).toEqual(['a']);
  });

  it('stops when saving is not allowed, failing the cards it never tried', async () => {
    const called: string[] = [];
    const r = await B.run(ids(6), async (id) => { called.push(id); throw problem('forbidden'); }, { ...clock(), concurrency: 1 });
    expect(called).toEqual(['c1']);
    expect(r.stopped?.code).toBe('forbidden');
    expect(r.saved).toEqual([]);
    expect(r.failed.map((f) => f.id)).toEqual(ids(6));
    expect(r.failed.every((f) => f.error?.code === 'forbidden')).toBe(true);
  });

  it('says how far it is and what did not save', () => {
    expect(B.progressText(120, 312)).toBe('Saving 120 of 312…');
    expect(B.partialText(300, 312, 12, { message: 'Couldn\'t reach the server' })).toBe('Saved 300 of 312. 12 didn\'t save: Couldn\'t reach the server');
    expect(B.partialText(300, 312, 12, null)).toBe('Saved 300 of 312. 12 didn\'t save.');
  });
});
