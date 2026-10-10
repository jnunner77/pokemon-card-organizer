import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { Config } from '../server/config';
import { Logger } from '../server/log';
import { PriceCharting } from '../server/pricing/pricecharting';
import { type Fetcher, retryPolicy } from '../server/pricing/sources';
import { PriceUpdater, type RunProblem, type RunSummary } from '../server/pricing/updater';
import { Store } from '../server/store';

// A price update that the server's restart cut short, that crashed it, or that stopped making
// progress: it's written down (a red banner, with the run's log) and can start again.

retryPolicy.baseMs = 1;
const BOC = { observations: [{ d: '2026-10-02', FXUSDCAD: { v: '1.4' } }] };
const card = (name: string) => ({ name, set: '30th Celebration', number: '131/128', status: 'binder', prices: [], pricing: { source: 'pricecharting', id: '100' } });

let dir: string;
let clock: number;
let store: Store;
let assets: Assets;
let log: Logger;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-stuck-'));
  clock = Date.parse('2026-10-03T16:00:00Z'); // 9:00 in Vancouver
  store = new Store(dir);
  assets = new Assets(dir);
  log = new Logger({ dir: path.join(dir, 'logs'), stdout: false, now: () => new Date(clock) });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A network where PriceCharting's answers wait while `hang` is on, until release() is called. */
function net() {
  let hang = false;
  const waiting: (() => void)[] = [];
  const fetcher: Fetcher = async (url) => {
    if (String(url).includes('bankofcanada')) return Response.json(BOC);
    if (hang) await new Promise<void>((r) => waiting.push(r));
    return Response.json({ status: 'success', id: '100', 'product-name': 'Lapras', 'console-name': 'Pokemon 30th Celebration', 'loose-price': 1000 });
  };
  return {
    fetcher,
    hang: (on: boolean) => void (hang = on),
    waiting: () => waiting.length,
    release: () => waiting.splice(0).forEach((r) => r()),
  };
}
const updater = (n: ReturnType<typeof net>) =>
  new PriceUpdater({ store, assets, log, fetcher: n.fetcher, now: () => new Date(clock), delayMs: 0, timeZone: 'America/Vancouver', pricecharting: new PriceCharting({ token: () => 'test-token', fetcher: n.fetcher, gapMs: 0 }) });
const status = () => store.get('settings', 'pricing') as { running: boolean; done: number; total: number; startedAt: string; current: { card: string } | null; problem: RunProblem | null; lastRun?: RunSummary; history: RunSummary[] };
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
}

describe('a price update that stops partway', () => {
  it('after the server stopped unexpectedly: written down as interrupted at startup, and can run again', async () => {
    // What the last server left: an update "running" at card 25 of 40.
    store.set('settings', 'pricing', { running: true, startedAt: '2026-10-03T12:05:00.000Z', reason: 'schedule', done: 24, total: 40, current: { card: 'Lapras 30C 131/128', since: '2026-10-03T12:20:00.000Z' } });
    const n = net();
    const u = updater(n);
    expect(u.running).toBe(false);
    const p = u.recover()!;
    expect(p).toMatchObject({ kind: 'interrupted', done: 24, total: 40, card: 'Lapras 30C 131/128', title: 'The price update was interrupted at card 25 of 40' });
    expect(p.message).toMatch(/stopped unexpectedly/);
    expect(p.graceful).toBeUndefined();
    expect(status()).toMatchObject({ running: false, current: null, history: [{ ended: 'interrupted', done: 24, total: 40, date: '2026-10-03' }] });
    expect(log.query({ cat: 'pricing', level: 'error' })[0].msg).toMatch(/interrupted at card 25 of 40/);
    // Once is enough.
    expect(u.recover()).toBeNull();
    // It isn't started again by itself the same day (a run that crashes the server would do it all day)...
    expect(u.dueToday()).toBe(false);
    // ...but by hand it is, and the banner stays (saying the later update went through) until dismissed.
    store.set('cards', 'c1', card('Lapras'));
    const s = await u.runAll('manual');
    expect(s.counts.updated).toBe(1);
    expect(status()).toMatchObject({ running: false, problem: { kind: 'interrupted', recoveredAt: expect.any(String) } });
    u.dismiss();
    expect(status().problem).toBeNull();
  });

  it('flags a run that stops making progress, and stop lets another start straight away', async () => {
    store.set('cards', 'c1', card('Lapras'));
    store.set('cards', 'c2', card('Mew'));
    const n = net();
    const u = updater(n);
    n.hang(true);
    const first = u.runAll('manual');
    await until(() => n.waiting() > 0);
    expect(status()).toMatchObject({ running: true, done: 0, total: 2, current: { card: 'Lapras 30th Celebration 131/128' } });
    // Not yet: 9 minutes is still progress as far as it knows.
    clock += 9 * 60_000;
    expect(u.checkStall()).toBeNull();
    clock += 2 * 60_000;
    const p = u.checkStall()!;
    expect(p).toMatchObject({ kind: 'stalled', card: 'Lapras 30th Celebration 131/128', step: 'asking PriceCharting', title: 'The price update is stuck at card 1 of 2' });
    expect(p.message).toMatch(/Nothing has happened for 11 minutes while asking PriceCharting for Lapras 30th Celebration 131\/128/);
    expect(status().problem).toMatchObject({ kind: 'stalled' });
    expect(log.query({ cat: 'pricing', level: 'error' })[0].msg).toMatch(/stalled: no progress for 11 minutes at card 1 of 2 \(Lapras 30th Celebration 131\/128, asking PriceCharting\)/);
    // Flagged once.
    expect(u.checkStall()).toBeNull();

    expect(u.stop('justin')).toBe(true);
    expect(u.running).toBe(false);
    expect(status()).toMatchObject({ running: false, current: null, history: [{ ended: 'stopped', done: 0, total: 2 }], problem: { kind: 'stalled' } });
    expect(status().problem!.message).toMatch(/justin stopped it\.$/);
    expect(status().lastRun).toBeUndefined();
    expect(u.stop('justin')).toBe(false);

    // The stuck request finally answers: the stopped run ends without writing anything more.
    n.hang(false);
    n.release();
    await first;
    expect(status()).toMatchObject({ running: false, history: [{ ended: 'stopped' }] });
    expect(status().history).toHaveLength(1);

    const s = await u.runAll('manual');
    expect(s.counts.updated).toBe(2);
    expect(status()).toMatchObject({ running: false, done: 2, lastRun: { counts: { updated: 2 } }, problem: { kind: 'stalled', recoveredAt: expect.any(String) } });
    expect(status().history.map((h) => h.ended ?? 'finished')).toEqual(['finished', 'stopped']);
  });

  it('says so when a stalled run moves on by itself', async () => {
    store.set('cards', 'c1', card('Lapras'));
    store.set('cards', 'c2', card('Mew'));
    const n = net();
    const u = updater(n);
    n.hang(true);
    const run = u.runAll('manual');
    await until(() => n.waiting() > 0);
    clock += 15 * 60_000;
    u.checkStall();
    n.hang(false);
    n.release();
    await run;
    expect(status().problem).toMatchObject({ kind: 'stalled', recoveredAt: expect.any(String) });
    expect(status().problem!.message).toMatch(/moved on by itself/);
    expect(log.query({ cat: 'pricing', text: 'moved on after stalling' })).toHaveLength(1);
  });

  it('a restart or crash during a run is written down before the server stops; a restart lets the daily run start again', async () => {
    store.set('cards', 'c1', card('Lapras'));
    const n = net();
    const u = updater(n);
    n.hang(true);
    const first = u.runAll('schedule');
    await until(() => n.waiting() > 0);
    const p = u.shutdown('The server was stopped (SIGTERM: a restart or an update)')!;
    expect(p).toMatchObject({ kind: 'interrupted', graceful: true, done: 0, total: 1, card: 'Lapras 30th Celebration 131/128', step: 'asking PriceCharting' });
    expect(p.message).toMatch(/^The server was stopped \(SIGTERM: a restart or an update\) during the update\. It was asking PriceCharting for Lapras 30th Celebration 131\/128\./);
    expect(status()).toMatchObject({ running: false, history: [{ ended: 'interrupted' }] });
    // The next server: nothing left to recover, and today's update starts again.
    const next = updater(n);
    expect(next.recover()).toBeNull();
    expect(next.dueToday()).toBe(true);
    n.hang(false);
    n.release();
    await first;

    // A crash: the error is in the banner, and the daily run doesn't start it again today.
    const third = updater(n);
    n.hang(true);
    const run = third.runAll('manual');
    await until(() => n.waiting() > 0);
    expect(third.crashed(new Error('Cannot read properties of undefined'))).toMatchObject({ kind: 'interrupted', message: expect.stringMatching(/^The server crashed during the update: Cannot read properties of undefined\./) });
    expect(updater(n).dueToday()).toBe(false);
    n.hang(false);
    n.release();
    await run;
  });
});

describe('the update’s log', () => {
  it('is read from the daily files, so it outlasts a restart', () => {
    log.info('pricing', 'Price update started (schedule) for 40 cards');
    log.info('http', 'GET /api/data');
    clock += 60_000;
    log.error('app', 'The server crashed (uncaught exception): Error: boom');
    const after = new Logger({ dir: path.join(dir, 'logs'), stdout: false, now: () => new Date(clock) });
    const lines = after.between('2026-10-03T15:00:00Z', '2026-10-03T17:00:00Z', { cats: ['pricing', 'app'] });
    expect(lines.map((e) => e.msg)).toEqual(['Price update started (schedule) for 40 cards', 'The server crashed (uncaught exception): Error: boom']);
    expect(after.between('2026-10-03T16:00:30Z', '2026-10-03T17:00:00Z').map((e) => e.cat)).toEqual(['app']);
  });

  it('is served to editors with the problem, and they can stop an update and dismiss the banner', async () => {
    const n = net();
    const u = updater(n);
    const app = createApp({ store, assets, log, config: new Config(dir), updater: u, publicDir: path.join(__dirname, '../public'), now: () => new Date(clock) });
    log.info('pricing', 'something from before the update');
    clock += 60 * 60_000;
    store.set('settings', 'pricing', { running: true, startedAt: new Date(clock).toISOString(), reason: 'schedule', done: 24, total: 40, current: { card: 'Lapras' } });
    log.info('pricing', 'Price update started (schedule) for 40 cards');
    clock += 5 * 60_000;
    log.error('app', 'The server crashed (uncaught exception): Error: boom');
    clock += 60_000;
    u.recover();
    const r = await request(app).get('/api/pricing/log').expect(200);
    expect(r.body.entries.map((e: { msg: string }) => e.msg)).toEqual([
      'Price update started (schedule) for 40 cards',
      'The server crashed (uncaught exception): Error: boom',
      expect.stringMatching(/^The price update was interrupted at card 25 of 40: The server stopped unexpectedly/),
    ]);
    await request(app).post('/api/pricing/stop').expect(200, { stopped: false });
    await request(app).post('/api/pricing/dismiss').expect(204);
    expect(status().problem).toBeNull();
  });
});
