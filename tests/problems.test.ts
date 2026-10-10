import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Accounts } from '../server/accounts';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { Config } from '../server/config';
import { Logger } from '../server/log';
import { groupProblems, problemFeed, problemKey } from '../server/problems';
import { Store } from '../server/store';

// Every warning and error in the app, for the problems banner: grouped, since they were last
// marked as seen, kept across a restart; and errors in the pages reported to the server.

let dir: string;
let clock: number;
let log: Logger;
const newLog = () => new Logger({ dir: path.join(dir, 'logs'), stdout: false, now: () => new Date(clock) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-problems-'));
  clock = Date.parse('2026-10-03T12:00:00Z');
  log = newLog();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the problems feed', () => {
  it('groups repeats that differ only in numbers and ids, newest first', () => {
    log.warn('pricing', 'PriceCharting answered 500');
    clock += 60_000;
    log.warn('pricing', 'PriceCharting answered 502');
    clock += 60_000;
    log.error('backup', 'Housekeeping failed: ENOSPC');
    log.info('pricing', 'Price update finished');
    const groups = groupProblems(log.problems());
    expect(groups).toEqual([
      { level: 'error', cat: 'backup', msg: 'Housekeeping failed: ENOSPC', count: 1, first: '2026-10-03T12:02:00.000Z', last: '2026-10-03T12:02:00.000Z' },
      { level: 'warn', cat: 'pricing', msg: 'PriceCharting answered 502', count: 2, first: '2026-10-03T12:00:00.000Z', last: '2026-10-03T12:01:00.000Z' },
    ]);
    expect(problemKey({ level: 'warn', cat: 'http', msg: 'POST /api/x 429 12 ms' })).toBe(problemKey({ level: 'warn', cat: 'http', msg: 'POST /api/x 429 340 ms' }));
    expect(problemKey({ level: 'warn', cat: 'http', msg: 'a' })).not.toBe(problemKey({ level: 'error', cat: 'http', msg: 'a' }));
  });

  it('counts only what came after "mark as seen", and outlasts a restart', () => {
    log.error('app', 'old error');
    clock += 60_000;
    const seenAt = new Date(clock).toISOString();
    clock += 60_000;
    log.warn('pricing', 'new warning');
    log.error('app', 'The server crashed (uncaught exception): Error: boom\n    at x (y.ts:1:2)');
    const after = newLog(); // the next server
    expect(problemFeed(after, seenAt)).toMatchObject({ seenAt, errors: 1, warnings: 1, latest: '2026-10-03T12:02:00.000Z', groups: [{ msg: expect.stringMatching(/^The server crashed/) }, { msg: 'new warning' }] });
    expect(problemFeed(after, seenAt, { all: true })).toMatchObject({ errors: 2, warnings: 1 });
    expect(problemFeed(after, '2026-10-03T13:00:00.000Z')).toMatchObject({ errors: 0, warnings: 0, groups: [], latest: null });
  });
});

describe('the problems API', () => {
  let store: Store;
  let accounts: Accounts;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    store = new Store(dir);
    accounts = new Accounts(dir, log, () => clock);
    await accounts.bootstrap('start password 1');
    app = createApp({ store, assets: new Assets(dir), accounts, log, config: new Config(dir), publicDir: path.join(__dirname, '../public'), envPassword: 'start password 1', now: () => new Date(clock) });
  });
  const signIn = async (username: string, password: string) => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username, password }).expect(200);
    return agent;
  };

  it('shows administrators what is new, and marks it as seen up to what they saw', async () => {
    const admin = await signIn('admin', 'start password 1');
    // From here on (creating "admin" from BINDER_PASSWORD is a warning of its own).
    clock += 1000;
    await admin.post('/api/admin/problems/seen').send({}).expect(200);
    clock += 1000;
    log.error('backup', 'Couldn’t take the daily copy: ENOSPC');
    clock += 1000;
    log.warn('pricing', 'TCGdex timed out');
    const r = await admin.get('/api/admin/problems').expect(200);
    expect(r.body).toMatchObject({ seenAt: '2026-10-03T12:00:01.000Z', errors: 1, warnings: 1, latest: '2026-10-03T12:00:03.000Z' });
    // One more arrives while the page shows the first two: it stays new.
    clock += 1000;
    log.warn('pricing', 'TCGdex timed out again, 3rd time');
    const seen = await admin.post('/api/admin/problems/seen').send({ upTo: r.body.latest }).expect(200);
    expect(seen.body).toMatchObject({ seenAt: '2026-10-03T12:00:03.000Z', errors: 0, warnings: 1 });
    expect((await admin.get('/api/admin/problems').expect(200)).body.warnings).toBe(1);
    expect((await admin.get('/api/admin/problems?all=1').expect(200)).body).toMatchObject({ errors: 1, warnings: 3 });
    // People who aren't administrators don't see the log.
    await admin.post('/api/admin/users').send({ username: 'ed', name: 'Ed', role: 'editor', password: 'a good password', mustChange: false }).expect(201);
    const ed = await signIn('ed', 'a good password');
    await ed.get('/api/admin/problems').expect(403);
  });

  it('logs errors in the pages, at most 30 a minute', async () => {
    const admin = await signIn('admin', 'start password 1');
    await request(app).post('/api/client-error').send({ message: 'x' }).expect(401);
    await admin.post('/api/client-error').send({ kind: 'error', message: "Cannot read properties of undefined (reading 'name')", page: 'binder', source: 'http://x/app.js', line: 812, col: 9, stack: 'TypeError: …' }).expect(204);
    const e = log.query({ cat: 'app', level: 'error' })[0];
    expect(e).toMatchObject({ msg: "Page error on binder: Cannot read properties of undefined (reading 'name')", data: { kind: 'error', at: 'http://x/app.js:812:9', stack: 'TypeError: …', user: 'admin' } });
    await admin.post('/api/client-error').send({ message: 'y'.repeat(600) }).expect(400);
    for (let i = 0; i < 40; i++) await admin.post('/api/client-error').send({ message: `loop ${i}` }).expect(204);
    expect(log.query({ cat: 'app', text: 'Page error' }).length).toBe(30);
    expect(log.query({ cat: 'app', text: 'more than 30 page errors' })).toHaveLength(1);
    clock += 61_000;
    await admin.post('/api/client-error').send({ message: 'later' }).expect(204);
    expect(log.query({ cat: 'app', text: 'Page error: later' })).toHaveLength(1);
  });
});

// public/problems.js is a plain browser script; load it the way the pages do.
type Feed = { seenAt: string | null; errors: number; warnings: number; groups: { level: string; cat: string; msg: string; count: number; first: string; last: string; data?: unknown }[]; latest: string | null };
type Problems = {
  banner: (f: Feed | null, o?: { logsHref?: string; timeZone?: string }) => string;
  list: (f: Feed | null) => string;
  text: (f: Feed, tz?: string) => string;
  pill: (f: Feed | null) => { kind: string; label: string; title: string } | null;
  catcher: (win: unknown, o: { page?: string; send: (r: unknown) => unknown; show: (m: string) => void }) => (kind: string, msg: string, extra?: object) => boolean;
};
const sandbox = { window: {} as { BinderProblems: Problems }, Intl, Date, JSON, Object, String, Promise, Map, Number };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/problems.js'), 'utf8'), sandbox);
const P = sandbox.window.BinderProblems;

describe('the problems banner', () => {
  const feed: Feed = {
    seenAt: '2026-10-02T12:00:00.000Z',
    errors: 2,
    warnings: 12,
    latest: '2026-10-03T12:00:00.000Z',
    groups: [
      { level: 'error', cat: 'backup', msg: 'Housekeeping failed: <ENOSPC>', count: 2, first: '2026-10-03T11:00:00.000Z', last: '2026-10-03T12:00:00.000Z', data: { path: '/data' } },
      { level: 'warn', cat: 'pricing', msg: 'PriceCharting answered 500', count: 12, first: '2026-10-03T05:00:00.000Z', last: '2026-10-03T05:20:00.000Z' },
      { level: 'warn', cat: 'http', msg: 'POST /api/x 409', count: 1, first: '2026-10-03T06:00:00.000Z', last: '2026-10-03T06:00:00.000Z' },
      { level: 'warn', cat: 'auth', msg: 'Failed sign-in', count: 1, first: '2026-10-03T06:00:00.000Z', last: '2026-10-03T06:00:00.000Z' },
    ],
  };
  it('is red with errors, amber with warnings only, and says how many since they were last seen', () => {
    const h = P.banner(feed, { logsHref: '#logs', timeZone: 'UTC' });
    expect(h).toContain('data-kind="bad"');
    expect(h).toContain('role="alert"');
    expect(h).toContain('2 errors, 12 warnings since you last looked (Oct 2, 12:00)');
    expect(h).toContain('Housekeeping failed: &lt;ENOSPC&gt;');
    expect(h).toContain('<span class="pb-n">12×</span> PriceCharting answered 500');
    expect(h).toContain('Show all (1 more)');
    expect(h).toContain('href="#logs"');
    expect(h.match(/data-probs="(\w+)"/g)).toEqual(['data-probs="all"', 'data-probs="copy"', 'data-probs="seen"']);
    const warn = P.banner({ ...feed, errors: 0, groups: feed.groups.slice(1) });
    expect(warn).toContain('data-kind="warn"');
    expect(P.banner({ ...feed, errors: 0, warnings: 0, groups: [] })).toBe('');
    expect(P.banner(null)).toBe('');
  });

  it('puts a count in the header, and copies as text', () => {
    expect(P.pill(feed)).toEqual({ kind: 'bad', label: '2 errors', title: '2 errors, 12 warnings since you last looked' });
    expect(P.pill({ ...feed, errors: 0, warnings: 1 })).toMatchObject({ kind: 'warn', label: '1 warning' });
    expect(P.pill({ ...feed, errors: 0, warnings: 0 })).toBeNull();
    expect(P.text(feed, 'UTC').split('\n').slice(0, 3)).toEqual(['2 errors, 12 warnings', 'Oct 3, 11:00 – Oct 3, 12:00 2×  ERROR  backup  Housekeeping failed: <ENOSPC> {"path":"/data"}', 'Oct 3, 05:00 – Oct 3, 05:20 12×  WARN   pricing  PriceCharting answered 500']);
    expect(P.list({ ...feed, groups: [] })).toContain('Nothing has failed or warned since you last looked');
  });

  it('reports and shows errors in the page, without flooding', async () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const win = { location: { pathname: '/' }, addEventListener: (k: string, fn: (e: unknown) => void) => void (listeners[k] = fn) };
    const sent: Record<string, unknown>[] = [];
    const shown: string[] = [];
    P.catcher(win, { page: 'binder', send: (r) => sent.push(r as Record<string, unknown>), show: (m) => shown.push(m) });
    listeners.error({ message: 'Uncaught TypeError: x is undefined', filename: 'http://x/app.js', lineno: 10, colno: 3, error: { stack: 'TypeError: x is undefined\n at f' } });
    listeners.error({ message: 'Uncaught TypeError: x is undefined' }); // the same, straight away
    listeners.error({}); // a picture that didn't load
    listeners.unhandledrejection({ reason: new Error('Failed to fetch') });
    expect(shown).toEqual(['Uncaught TypeError: x is undefined', 'Failed to fetch']);
    expect(sent).toEqual([
      { kind: 'error', message: 'Uncaught TypeError: x is undefined', page: 'binder', source: 'http://x/app.js', line: 10, col: 3, stack: 'TypeError: x is undefined\n at f' },
      { kind: 'rejection', message: 'Failed to fetch', page: 'binder', stack: expect.stringContaining('Error: Failed to fetch') },
    ]);
    for (let i = 0; i < 30; i++) listeners.error({ message: `loop ${i}` });
    expect(sent).toHaveLength(20);
    // A reporter that fails doesn't throw into the page.
    const h = P.catcher(win, { send: () => Promise.reject(new Error('offline')), show: () => { throw new Error('no banner'); } });
    expect(h('error', 'boom')).toBe(true);
  });
});
