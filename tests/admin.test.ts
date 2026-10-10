import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Accounts } from '../server/accounts';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { Backups, isoWeek, retain } from '../server/backups';
import { Config } from '../server/config';
import { Logger, redact } from '../server/log';
import { PriceCharting } from '../server/pricing/pricecharting';
import { type Fetcher, retryPolicy } from '../server/pricing/sources';
import { PriceUpdater } from '../server/pricing/updater';
import { Security } from '../server/security';
import { DETAILS_VERSION } from '../server/details';
import { cardsNeedingAttention } from '../server/status';
import { Store } from '../server/store';

retryPolicy.baseMs = 1;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a photo')]);
const card = { name: 'Lapras', set: '30th Celebration', number: '131/128', status: 'binder', prices: [] };

let dir: string;
let clock: number;
let store: Store;
let assets: Assets;
let log: Logger;
let accounts: Accounts;
let config: Config;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-admin-'));
  clock = Date.parse('2026-10-03T12:00:00Z');
  store = new Store(dir);
  assets = new Assets(dir);
  log = new Logger({ dir: path.join(dir, 'logs'), stdout: false, now: () => new Date(clock) });
  accounts = new Accounts(dir, log, () => clock);
  config = new Config(dir);
  await accounts.bootstrap('start password 1');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const makeApp = (extra: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ store, assets, accounts, log, config, publicDir: path.join(__dirname, '../public'), envPassword: 'start password 1', now: () => new Date(clock), ...extra });

async function signIn(app: ReturnType<typeof makeApp>, username: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ username, password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return agent;
}

async function addUser(admin: request.Agent, username: string, role: string, password = 'a good password', mustChange = false) {
  const r = await admin.post('/api/admin/users').send({ username, name: username, role, password, mustChange });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
}

describe('people and sign-in', () => {
  it('creates the first administrator from BINDER_PASSWORD and signs in', async () => {
    const app = makeApp();
    await request(app).get('/api/data').expect(401);
    expect((await request(app).get('/').expect(302)).headers.location).toBe('login.html');
    const admin = await signIn(app, 'admin', 'start password 1');
    await admin.get('/api/data').expect(200);
    expect((await admin.get('/api/auth/me')).body.user).toMatchObject({ username: 'admin', role: 'admin' });
    await admin.get('/admin.html').expect(200);
  });

  it('without BINDER_PASSWORD, the first administrator needs the setup code from the log', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-setup-'));
    try {
      const acc = new Accounts(d2, log);
      await acc.bootstrap(undefined);
      const app = createApp({ store: new Store(d2), assets: new Assets(d2), accounts: acc, log });
      expect((await request(app).get('/api/auth/me')).body.setupRequired).toBe(true);
      await request(app).post('/api/auth/setup').send({ setupCode: 'WRONG', username: 'ash', name: 'Ash', password: 'pallet town 99' }).expect(401);
      const agent = request.agent(app);
      await agent.post('/api/auth/setup').send({ setupCode: acc.setupCode!.toLowerCase(), username: 'ash', name: 'Ash', password: 'pallet town 99' }).expect(200);
      await agent.get('/api/admin/users').expect(200);
      await request(app).post('/api/auth/setup').send({ setupCode: 'x', username: 'eve', name: 'Eve', password: 'pallet town 99' }).expect(400);
    } finally {
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });

  it('gives viewers read-only access and keeps administration to administrators', async () => {
    const app = makeApp();
    const admin = await signIn(app, 'admin', 'start password 1');
    await addUser(admin, 'misty', 'viewer');
    await addUser(admin, 'brock', 'editor');
    const viewer = await signIn(app, 'misty', 'a good password');
    const editor = await signIn(app, 'brock', 'a good password');
    await viewer.get('/api/data').expect(200);
    expect((await viewer.put('/api/docs/cards/c1').send(card).expect(403)).body.error).toMatch(/view-only/);
    await editor.put('/api/docs/cards/c1').send(card).expect(200);
    await editor.get('/api/admin/users').expect(403);
    await editor.get('/admin.html').expect(302);
    // The server's own settings can't be written from the page.
    await editor.put('/api/docs/settings/pricing').send({ running: false }).expect(403);
    await editor.put('/api/docs/settings/main').send({ usdToCad: 1.4 }).expect(200);
    await viewer.post('/api/restore').send({}).expect(403);
  });

  it('makes people with a temporary password choose their own, and signs them out elsewhere', async () => {
    const app = makeApp();
    const admin = await signIn(app, 'admin', 'start password 1');
    await addUser(admin, 'gary', 'editor', 'temporary pass 1', true);
    const r = await request(app).post('/api/auth/login').send({ username: 'gary', password: 'temporary pass 1' }).expect(200);
    expect(r.body.status).toBe('change');
    expect(r.headers['set-cookie']).toBeUndefined();
    await request(app).post('/api/auth/password').send({ username: 'gary', currentPassword: 'temporary pass 1', newPassword: 'gary' }).expect(400);
    await request(app).post('/api/auth/password').send({ username: 'gary', currentPassword: 'temporary pass 1', newPassword: 'password123' }).expect(400);
    const agent = request.agent(app);
    await agent.post('/api/auth/password').send({ username: 'gary', currentPassword: 'temporary pass 1', newPassword: 'smell ya later 7' }).expect(200);
    await agent.get('/api/data').expect(200);
  });

  it('locks a username after repeated wrong passwords, twice as long each time', async () => {
    const app = makeApp();
    const wrong = () => request(app).post('/api/auth/login').send({ username: 'admin', password: 'nope' });
    for (let i = 0; i < 5; i++) await wrong().expect(401);
    const locked = await wrong().expect(429);
    expect(locked.headers['retry-after']).toBe('60');
    clock += 61_000;
    for (let i = 0; i < 5; i++) await wrong().expect(401);
    expect((await wrong().expect(429)).headers['retry-after']).toBe('120');
    clock += 121_000;
    // The right password works once the lock is over, and resets the count.
    await request(app).post('/api/auth/login').send({ username: 'admin', password: 'start password 1' }).expect(200);
    expect(log.query({ cat: 'security', text: 'locked' })).toHaveLength(2);
  });

  it('ends sessions after the idle time, and when a person is deactivated', async () => {
    const app = makeApp();
    const admin = await signIn(app, 'admin', 'start password 1');
    const u = await addUser(admin, 'tracey', 'editor');
    const tracey = await signIn(app, 'tracey', 'a good password');
    await tracey.get('/api/data').expect(200);
    await admin.patch(`/api/admin/users/${u.id}`).send({ active: false }).expect(200);
    await tracey.get('/api/data').expect(401);
    clock += 15 * 86_400_000; // longer than the 14-day idle limit
    await admin.get('/api/data').expect(401);
  });

  it('always keeps an active administrator', async () => {
    const app = makeApp();
    const admin = await signIn(app, 'admin', 'start password 1');
    const me = (await admin.get('/api/admin/users')).body.users[0];
    await admin.patch(`/api/admin/users/${me.id}`).send({ role: 'editor' }).expect(400);
    await admin.delete(`/api/admin/users/${me.id}`).expect(400);
  });

  it('keeps sessions across restarts', async () => {
    const app = makeApp();
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'start password 1' }).expect(200);
    const restarted = createApp({ store, assets, accounts: new Accounts(dir, log, () => clock), log, config });
    await request(restarted).get('/api/data').set('Cookie', login.headers['set-cookie']).expect(200);
  });
});

describe('API tokens', () => {
  it('act as a person, read-only or read & write, never admin, until revoked or expired', async () => {
    const app = makeApp();
    const admin = await signIn(app, 'admin', 'start password 1');
    const me = (await admin.get('/api/admin/users')).body.users[0];
    const read = (await admin.post('/api/admin/tokens').send({ name: 'reader', userId: me.id, scope: 'read', expiresInDays: 1 }).expect(201)).body;
    const write = (await admin.post('/api/admin/tokens').send({ name: 'writer', userId: me.id, scope: 'write' }).expect(201)).body;
    expect(read.token).toMatch(/^binder_/);
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    await request(app).get('/api/data').set(bearer(read.token)).expect(200);
    await request(app).put('/api/docs/cards/c1').set(bearer(read.token)).send(card).expect(403);
    await request(app).put('/api/docs/cards/c1').set(bearer(write.token)).send(card).expect(200);
    await request(app).get('/api/admin/users').set(bearer(write.token)).expect(403);
    await request(app).get('/api/data').set(bearer('binder_forged')).expect(401);
    expect(JSON.stringify((await admin.get('/api/admin/tokens')).body)).not.toContain(write.token);
    await admin.delete(`/api/admin/tokens/${write.id}`).expect(204);
    await request(app).get('/api/data').set(bearer(write.token)).expect(401);
    clock += 2 * 86_400_000;
    await request(app).get('/api/data').set(bearer(read.token)).expect(401);
  });
});

describe('rate limits and blocks', () => {
  it('answers 429 with Retry-After, and blocks repeat offenders for longer each time', async () => {
    const sec = new Security({ ip: { burst: 3, perMinute: 1 }, ban: { violations: 2, authFailures: 20, notFound: 120, windowMs: 600_000, durationMs: 60_000, maxDurationMs: 3_600_000 } }, log, () => clock);
    const app = makeApp({ security: sec });
    for (let i = 0; i < 3; i++) await request(app).get('/login.html').expect(200);
    const limited = await request(app).get('/login.html').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await request(app).get('/login.html').expect(429); // second violation: blocked
    expect((await request(app).get('/login.html').expect(403)).body.code).toBe('blocked');
    expect(sec.listBans()[0]).toMatchObject({ strikes: 1 });
    clock += 61_000 + 3 * 60_000; // block over, bucket refilled
    for (let i = 0; i < 3; i++) await request(app).get('/login.html').expect(200);
    await request(app).get('/login.html').expect(429);
    await request(app).get('/login.html').expect(429);
    const second = sec.listBans()[0];
    expect(second.strikes).toBe(2);
    expect(Date.parse(second.until) - clock).toBe(120_000); // doubled
    expect(sec.unban(second.ip)).toBe(true);
    await request(app).get('/api/health').expect(200);
  });

  it('blocks an address that keeps failing to sign in', async () => {
    const sec = new Security({ signIn: { burst: 100, perMinute: 100 }, ban: { violations: 60, authFailures: 3, notFound: 120, windowMs: 600_000, durationMs: 60_000, maxDurationMs: 3_600_000 } }, log, () => clock);
    const app = makeApp({ security: sec });
    for (const u of ['a', 'b', 'c']) await request(app).post('/api/auth/login').send({ username: u, password: 'x' }).expect(401);
    await request(app).post('/api/auth/login').send({ username: 'admin', password: 'start password 1' }).expect(403);
  });
});

describe('backups', () => {
  it('keeps days, then weeks, then months', () => {
    const days: string[] = [];
    for (let t = Date.parse('2025-01-01'); t <= Date.parse('2026-10-03'); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
    const keep = [...retain(days, { daily: 14, weekly: 8, monthly: 12 })].sort();
    expect(keep).toContain('2026-10-03');
    expect(keep).toContain('2026-09-20'); // within 14 days
    expect(keep.filter((d) => d < '2026-09-20').length).toBeGreaterThan(5); // weekly and monthly copies
    expect(keep).not.toContain('2025-06-15');
    expect(keep.length).toBeLessThanOrEqual(14 + 8 + 12);
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
    expect(isoWeek('2026-10-03')).toBe('2026-W40');
  });

  it('snapshots, restores and brings deleted photos back', async () => {
    const app = makeApp();
    const admin = await signIn(app, 'admin', 'start password 1');
    const photo = (await admin.post('/api/assets').set('Content-Type', 'image/jpeg').send(JPEG).expect(201)).body.id;
    await admin.put('/api/docs/cards/c1').send({ ...card, imageId: photo }).expect(200);
    const snap = (await admin.post('/api/admin/backups/snapshot').send({ label: 'Before cleanup' }).expect(201)).body;
    expect(snap).toMatchObject({ kind: 'snapshot', label: 'before cleanup' });
    await admin.delete('/api/docs/cards/c1').expect(204);
    await admin.delete(`/api/assets/${photo}`).expect(204);
    await admin.get(`/blob/${photo}`).expect(404);
    const r = await admin.post(`/api/admin/backups/${snap.name}/restore`).expect(200);
    expect(r.body).toEqual({ cards: 1, photosRecovered: 1 });
    await admin.get(`/blob/${photo}`).expect(200);
    const list = (await admin.get('/api/admin/backups')).body.backups;
    expect(list.map((b: { kind: string }) => b.kind)).toContain('before-restore');
    await admin.get(`/api/admin/backups/${snap.name}`).expect(200);
    await admin.get('/api/admin/backups/..%2Fauth.json').expect(404);
  });

  it('takes the daily copy and applies retention', () => {
    const backups = new Backups(store, assets, config, log);
    store.set('cards', 'c1', card);
    for (const d of ['2026-01-05', '2026-01-06', '2026-02-10', '2026-09-30']) fs.writeFileSync(path.join(store.backupDir, `db-${d}.json`), '{}');
    config.set({ backups: { daily: 2, weekly: 0, monthly: 0 } });
    backups.ensureDaily('2026-10-03');
    expect(backups.list().filter((b) => b.kind === 'daily').map((b) => b.name)).toEqual(['db-2026-10-03.json', 'db-2026-09-30.json']);
  });
});

describe('logs and checks', () => {
  it('hides secrets and keeps a file per day', async () => {
    expect(redact({ username: 'a', password: 'p', nested: { token: 't', ok: 1 } })).toEqual({ username: 'a', password: '[hidden]', nested: { token: '[hidden]', ok: 1 } });
    const app = makeApp();
    await request(app).post('/api/auth/login').send({ username: 'admin', password: 'oops' }).expect(401);
    const admin = await signIn(app, 'admin', 'start password 1');
    const body = (await admin.get('/api/admin/logs?cat=auth&q=sign').expect(200)).body;
    const msgs = body.entries.map((e: { msg: string }) => e.msg);
    expect(msgs.slice(0, 2)).toEqual(['admin signed in', 'Failed sign-in for "admin"']);
    expect(fs.readFileSync(path.join(dir, 'logs', '2026-10-03.jsonl'), 'utf8')).not.toContain('start password 1');
    await admin.get('/api/admin/logs/files/2026-10-03.jsonl').expect(200);
    await admin.get('/api/admin/logs/files/..%2Fauth.json').expect(404);
    await admin.get('/api/admin/logs?level=nonsense').expect(400);
  });

  it('reports what still needs doing before going public', async () => {
    const app = makeApp({ security: new Security({}, log, () => clock), trustProxy: 1 });
    const admin = await signIn(app, 'admin', 'start password 1');
    const checks = (await admin.get('/api/admin/overview').set('X-Forwarded-For', '203.0.113.9').expect(200)).body.checks as { id: string; status: string }[];
    const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({ auth: 'pass', https: 'fail', 'env-password': 'warn', offsite: 'warn', 'rate-limits': 'pass', 'daily-copy': 'fail' });
    // A secure request through the proxy, a fresh copy and a downloaded backup.
    new Backups(store, assets, config, log).ensureDaily(new Date(clock).toISOString().slice(0, 10));
    store.set('cards', 'c1', card);
    new Backups(store, assets, config, log, () => new Date(clock)).ensureDaily();
    await admin.get('/api/backup').expect(200);
    const again = (await admin.get('/api/admin/overview').set('X-Forwarded-Proto', 'https').set('X-Forwarded-For', '203.0.113.9').expect(200)).body.checks as { id: string; status: string }[];
    const s2 = Object.fromEntries(again.map((c) => [c.id, c.status]));
    expect(s2).toMatchObject({ https: 'pass', offsite: 'pass', 'daily-copy': 'pass' });
  });
});

describe('status for the nightly job', () => {
  it('counts an automatic copy off the server', async () => {
    const app = makeApp({ trustProxy: 1 });
    const admin = await signIn(app, 'admin', 'start password 1');
    const offsite = async () => ((await admin.get('/api/admin/overview').expect(200)).body.checks as { id: string; status: string; detail: string }[]).find((c) => c.id === 'offsite')!;
    expect((await offsite()).status).toBe('warn');
    fs.writeFileSync(path.join(dir, 'offsite.json'), JSON.stringify({ at: new Date(clock).toISOString(), where: 'gs://nunner-backups/binder/binder-1.tar.gz' }));
    expect(await offsite()).toMatchObject({ status: 'pass', detail: 'The nightly job copied a backup to gs://nunner-backups/binder/binder-1.tar.gz today.' });
    fs.writeFileSync(path.join(dir, 'offsite.json'), JSON.stringify({ at: new Date(clock - 5 * 86_400_000).toISOString(), where: 'gs://x/y' }));
    expect(await offsite()).toMatchObject({ status: 'warn', detail: 'The nightly job last copied a backup off the server 5 days ago.' });
    fs.writeFileSync(path.join(dir, 'offsite.json'), '{"at":"not a date"}');
    expect((await offsite()).detail).toBe('No full backup has been downloaded from here.');
  });

  it('writes the checks and the cards that need a person to status.txt', async () => {
    const app = makeApp();
    store.set('cards', 'a', { ...card, name: 'Bill', set: 'Base Set', number: '118/130', pricing: { source: 'none', candidates: [] } });
    store.set('cards', 'b', { ...card, name: 'Pikachu', setCode: 'M22', number: '7/15', pricing: { source: 'tcgplayer', id: '1', error: "TCGplayer has no price for this printing of the card. If it's the wrong product, choose another." } });
    store.set('cards', 'c', { ...card, name: 'Gengar', pricing: { source: 'pricecharting', id: '2', error: "PriceCharting didn't answer." } });
    store.set('cards', 'e', { ...card, name: 'Eevee', pricing: { source: 'none', error: "Couldn't reach PriceCharting" } });
    store.set('cards', 'd', { ...card, name: 'Sold one', status: 'sold', pricing: { source: 'none' } });
    await app.writeStatusFile();
    const lines = fs.readFileSync(path.join(dir, 'status.txt'), 'utf8').trimEnd().split('\n');
    expect(lines[0]).toMatch(/^written \d{4}-\d\d-\d\dT/);
    expect(lines).toContain('ok Sign-in required: Everyone must sign in; every page, picture and API call is refused without a session or API token.');
    expect(lines.find((l) => l.startsWith('warn Start-up password:'))).toContain('Fix: Sign in as admin');
    expect(lines.find((l) => l.startsWith('warn Copy off the server:'))).toContain('Fix: Set up the nightly job');
    expect(lines.filter((l) => / HTTPS:| Reverse proxy:/.test(l))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('attention '))).toEqual([
      'attention Bill Base Set 118/130: no certain match. Open the card and choose the product.',
      "attention Pikachu M22 7/15: TCGplayer has no price for this printing of the card. If it's the wrong product, choose another.",
    ]);
  });

  it('lists ten cards by name and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `Card ${i + 1}`, pricing: { source: 'none', candidates: [] } }));
    const out = cardsNeedingAttention(many);
    expect(out).toHaveLength(11);
    expect(out[9]).toBe('Card 10: no certain match. Open the card and choose the product.');
    expect(out[10]).toBe('…and 3 more. Open Cards to check in the binder.');
  });

  it("lists cards whose details look wrong, until they're fixed or ignored", () => {
    const v = DETAILS_VERSION;
    const at = '2026-10-03T00:00:00Z';
    const cards = [
      { name: 'Bill', number: '118/130', set: 'Pokemon Base Set', setCode: 'PBS', details: { result: 'filled' as const, v, set: 'Base Set 2', filedUnder: { as: 'Pokemon Base Set', id: 'base1', name: 'Base Set' }, checkedAt: at } },
      { name: 'Bill', number: '118/130', set: 'Pokemon Base Set 2', setCode: 'PBS', details: { result: 'filled' as const, v, set: 'Base Set 2', filedUnder: { as: 'Pokemon Base Set', id: 'base1', name: 'Base Set' }, checkedAt: at } },
      { name: 'Mega Eelktross EX', number: '61/217', setCode: 'ASC', details: { result: 'notFound' as const, v, suggest: [{ id: 'me02.5-061', name: 'Mega Eelektross ex', set: 'Ascended Heroes', setCode: 'ASC', number: '061', total: 217, thumb: null }], checkedAt: at } },
      { name: 'Pikachu', number: '51', details: { result: 'several' as const, v, checkedAt: at } },
      { name: 'Mr. Mime', number: '13/34', setCode: 'CLB', details: { result: 'notFound' as const, v, checkedAt: at } },
      { name: 'Lugia EX', number: '17/34', setCode: 'CLV', checksIgnored: 'lugia ex|17/34', details: { result: 'notFound' as const, v, checkedAt: at } },
      { name: 'Old', number: '1/2', details: { result: 'notFound' as const, checkedAt: at } },
      // Not in TCGdex, but a price site matched it: its name and number are confirmed.
      { name: 'Nidorina', number: '101', setCode: 'MEP', pricing: { source: 'pricecharting', id: '/game/pokemon-promo/nidorina-101' }, details: { result: 'notFound' as const, v, checkedAt: at } },
    ];
    expect(cardsNeedingAttention(cards)).toEqual([
      "Bill PBS 118/130: filed under Base Set, but it's from Base Set 2. Open Cards to check in the binder.",
      'Mega Eelktross EX ASC 61/217: not in the card database. Did you mean Mega Eelektross ex? Open Cards to check in the binder.',
      'Pikachu 51: several cards match. Choose yours. Open Cards to check in the binder.',
      'Mr. Mime CLB 13/34: not in the card database (TCGdex). Check its name and number, or ignore it. Open Cards to check in the binder.',
    ]);
  });
});

describe('the daily price update under trouble', () => {
  it('retries a busy site with backoff, and stops asking a site that keeps failing', async () => {
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      calls++;
      if (String(url).includes('bankofcanada')) return new Response(JSON.stringify({ observations: [{ d: '2026-10-02', FXUSDCAD: { v: '1.4' } }] }));
      return new Response('busy', { status: 503 });
    };
    for (let i = 0; i < 8; i++) store.set('cards', `c${i}`, { ...card, pricing: { source: 'pricecharting', id: String(100 + i) } });
    const pricecharting = new PriceCharting({ token: () => 'test-token', fetcher, gapMs: 0 });
    const u = new PriceUpdater({ store, assets, fetcher, delayMs: 0, log, breakerAfter: 3, pricecharting });
    const s = await u.runAll('manual');
    expect(s.counts.failed).toBe(8);
    // 3 cards tried (3 attempts each) before the breaker; the other 5 weren't requested at all.
    expect(calls).toBe(1 + 3 * retryPolicy.attempts);
    expect(store.get('cards', 'c7')!.pricing).toMatchObject({ error: expect.stringMatching(/kept failing/) });
    expect((store.get('settings', 'pricing') as { history: unknown[] }).history).toHaveLength(1);
    expect(log.query({ cat: 'pricing', text: 'skipping it' })).toHaveLength(1);
  });
});
