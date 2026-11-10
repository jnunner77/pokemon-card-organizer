import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/runtime.js is the page's storage layer; load it with a fake browser and call the API the way the page does.
type Api = { call(method: string, url: string, body?: unknown): Promise<unknown> };
function load(answer: { status: number; headers?: Record<string, string>; body?: unknown }): Api {
  const response = {
    ok: answer.status < 400,
    status: answer.status,
    statusText: 'Too Many Requests',
    headers: { get: (name: string) => answer.headers?.[name] ?? null },
    json: async () => answer.body ?? {},
  };
  const window: Record<string, unknown> = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/runtime.js'), 'utf8'), { window, fetch: async () => response, location: { assign() {} }, console });
  return window['ledgerApi'] as Api;
}
const rejection = async (api: Api) => api.call('PATCH', 'api/docs/cards/c1', {}).then(() => null, (e: Error & { code?: string; retryAfter?: number }) => e);

describe('the page\'s API calls', () => {
  it('carries how long to wait from a Retry-After header', async () => {
    const e = await rejection(load({ status: 429, headers: { 'Retry-After': '3' }, body: { error: 'Too many changes' } }));
    expect(e?.code).toBe('rate_limited');
    expect(e?.retryAfter).toBe(3);
  });

  it('leaves it unset without a usable Retry-After', async () => {
    for (const headers of [{}, { 'Retry-After': 'soon' }, { 'Retry-After': '0' }] as Record<string, string>[]) {
      const e = await rejection(load({ status: 429, headers, body: { error: 'Too many changes' } }));
      expect(e?.code).toBe('rate_limited');
      expect(e && 'retryAfter' in e).toBe(false);
    }
  });
});

// The stream opens first and the ledger loads after it says hello, so nothing saved in between is missed.
type Doc = { id: string; name: string };
type Snap = { docs: { id: string; data(): { name: string } }[] };
type Db = { collection(c: string): { onSnapshot(fn: (s: Snap) => void): () => void } };
class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  closed = false;
  listeners = new Map<string, (() => void)[]>();
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  emit(name: string) { for (const fn of this.listeners.get(name) ?? []) fn(); }
  message(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  fail() { this.onerror?.(); }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
}

function startPage() {
  FakeEventSource.instances = [];
  const loads: { resolve(cards: Doc[]): void; reject(e: Error): void }[] = [];
  const events: string[] = [];
  const notices = new Set<object>();
  const timers = new Map<number, { fn(): void; ms: number }>();
  let tid = 0;
  const window: Record<string, unknown> = { dispatchEvent: (e: { type: string }) => { events.push(e.type); }, reportError: (e: unknown) => { throw e; } };
  const sandbox = {
    window, console: { error() {}, log() {} },
    CustomEvent: class { constructor(public type: string, public init?: unknown) {} },
    EventSource: FakeEventSource,
    location: { assign() {} },
    document: { createElement: () => { const el = { setAttribute() {}, remove() { notices.delete(el); } }; return el; }, body: { appendChild: (el: object) => { notices.add(el); } } },
    setTimeout: (fn: () => void, ms: number) => { timers.set(++tid, { fn, ms }); return tid; },
    clearTimeout: (id: number) => { timers.delete(id); },
    fetch: (url: string) => {
      if (url !== 'api/data') return Promise.reject(new Error('unexpected ' + url));
      return new Promise(resolve => loads.push({
        resolve: cards => resolve({ ok: true, status: 200, json: async () => ({ cards }) }),
        reject: e => resolve(Promise.reject(e)),
      }));
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/runtime.js'), 'utf8'), sandbox);
  const claude = window['claude'] as { use(n: string): Promise<Db | null> };
  const names = (db: Db) => { let seen: string[] = []; db.collection('cards').onSnapshot(s => { seen = s.docs.map(d => d.data().name).sort(); }); return () => seen; };
  const change = (id: string, name: string) => ({ type: 'change', change: { collection: 'cards', id, doc: { id, name } } });
  const fire = (ms: number) => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } };
  const pending = (ms: number) => [...timers.values()].filter(t => t.ms === ms).length;
  const settle = () => new Promise(r => setTimeout(r, 0));
  return { claude, loads, events, notices, fire, pending, es: () => FakeEventSource.instances, change, names, settle };
}

describe('the page\'s live updates while it loads', () => {
  it('waits for the stream to say hello before it loads the ledger, once', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    await p.settle();
    expect(p.es()).toHaveLength(1);
    expect(p.loads).toHaveLength(0);
    p.es()[0].emit('hello');
    await p.settle();
    expect(p.loads).toHaveLength(1);
    p.loads[0].resolve([]);
    expect(await ready).not.toBeNull();
    expect(await p.claude.use('assets')).not.toBeNull();
    expect(p.loads).toHaveLength(1);
  });

  it('applies a change that arrived during the load on top of it', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.es()[0].message(p.change('c1', 'New'));
    p.loads[0].resolve([{ id: 'c1', name: 'Old' }]);
    const db = (await ready)!;
    expect(p.names(db)()).toEqual(['New']);
  });

  it('applies changes held during a load in order', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.es()[0].message(p.change('c1', 'Second'));
    p.es()[0].message(p.change('c1', 'Third'));
    p.loads[0].resolve([{ id: 'c1', name: 'First' }]);
    expect(p.names((await ready)!)()).toEqual(['Third']);
  });

  it('loads again on a reconnect and holds changes the same way', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.loads[0].resolve([{ id: 'c1', name: 'Old' }]);
    const names = p.names((await ready)!);
    p.es()[0].emit('hello');
    await p.settle();
    expect(p.loads).toHaveLength(2);
    expect(p.events).toContain('binder:reconnected');
    p.es()[0].message(p.change('c1', 'New'));
    expect(names()).toEqual(['Old']);
    p.loads[1].resolve([{ id: 'c1', name: 'Stale' }]);
    await p.settle();
    expect(names()).toEqual(['New']);
  });

  it('loads again after a reset that arrived during a load, once the first is done', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.es()[0].message({ type: 'reset' });
    p.es()[0].message(p.change('c1', 'Queued'));
    expect(p.loads).toHaveLength(1);
    p.loads[0].resolve([{ id: 'c1', name: 'Old' }]);
    const names = p.names((await ready)!);
    await p.settle();
    expect(p.loads).toHaveLength(2);
    p.loads[1].resolve([{ id: 'c1', name: 'Restored' }]);
    await p.settle();
    expect(names()).toEqual(['Restored']);
  });

  it('closes the stream and gives no database when the ledger can\'t be loaded', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.loads[0].reject(new Error('down'));
    expect(await ready).toBeNull();
    expect(p.es()[0].closed).toBe(true);
    p.es()[0].fail();
    expect(p.es()).toHaveLength(1);
  });

  it('takes the reconnecting notice down when the stream failed first and the load fails too', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].fail();
    await p.settle();
    expect(p.notices.size).toBe(1);
    p.loads[0].reject(new Error('down'));
    expect(await ready).toBeNull();
    expect(p.es()[0].closed).toBe(true);
    expect(p.notices.size).toBe(0);
  });

  it('still loads the ledger when the stream fails before any hello, and once a hello follows it loads again', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].fail();
    await p.settle();
    expect(p.loads).toHaveLength(1);
    p.loads[0].resolve([{ id: 'c1', name: 'Old' }]);
    expect(await ready).not.toBeNull();
    p.es()[0].emit('hello');
    await p.settle();
    expect(p.loads).toHaveLength(2);
    p.loads[1].resolve([{ id: 'c1', name: 'Old' }]);
  });

  it('survives a failed reload without leaving the page stuck', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.loads[0].resolve([{ id: 'c1', name: 'Old' }]);
    const names = p.names((await ready)!);
    p.es()[0].emit('hello');
    await p.settle();
    p.es()[0].message(p.change('c1', 'Held'));
    p.loads[1].reject(new Error('down'));
    await p.settle();
    expect(names()).toEqual(['Held']);
    p.es()[0].message(p.change('c1', 'Live'));
    expect(names()).toEqual(['Live']);
    p.es()[0].emit('hello');
    await p.settle();
    expect(p.loads).toHaveLength(3);
  });

  it('shows an open trade at once, even while a load is in flight', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.es()[0].message({ type: 'openTrade', id: 't1', trade: null });
    expect(p.events).toContain('binder:opentrade');
    p.loads[0].resolve([]);
    await ready;
  });

  it('loads once more, after the first has finished, for a hello that arrives during a load', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.es()[0].emit('hello');
    await p.settle();
    expect(p.loads).toHaveLength(1);
    p.loads[0].resolve([]);
    await ready;
    await p.settle();
    expect(p.loads).toHaveLength(2);
    p.loads[1].resolve([]);
    await p.settle();
    expect(p.loads).toHaveLength(2);
  });

  it('serves several hellos during one load with a single further load', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].emit('hello');
    await p.settle();
    p.es()[0].emit('hello');
    p.es()[0].emit('hello');
    p.loads[0].resolve([]);
    await ready;
    await p.settle();
    expect(p.loads).toHaveLength(2);
    p.loads[1].resolve([]);
    await p.settle();
    expect(p.loads).toHaveLength(2);
  });

  it('loads anyway when the stream neither says hello nor fails within 5 seconds', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    await p.settle();
    expect(p.loads).toHaveLength(0);
    p.fire(5000);
    await p.settle();
    expect(p.loads).toHaveLength(1);
    p.loads[0].resolve([]);
    expect(await ready).not.toBeNull();
    p.fire(5000);
    await p.settle();
    expect(p.loads).toHaveLength(1);
  });

  it('loads again when the hello comes after the fallback, holding changes the same way', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.fire(5000);
    await p.settle();
    p.loads[0].resolve([{ id: 'c1', name: 'Old' }]);
    const names = p.names((await ready)!);
    p.es()[0].emit('hello');
    await p.settle();
    expect(p.loads).toHaveLength(2);
    p.es()[0].message(p.change('c1', 'New'));
    p.loads[1].resolve([{ id: 'c1', name: 'Stale' }]);
    await p.settle();
    expect(names()).toEqual(['New']);
  });

  it('clears the fallback timer on a hello or an error before 5 seconds', async () => {
    for (const how of ['hello', 'error']) {
      const p = startPage();
      const ready = p.claude.use('db');
      expect(p.pending(5000)).toBe(1);
      if (how === 'hello') p.es()[0].emit('hello'); else p.es()[0].fail();
      await p.settle();
      expect(p.pending(5000)).toBe(0);
      p.fire(5000);
      p.loads[0].resolve([]);
      await ready;
      await p.settle();
      expect(p.loads).toHaveLength(1);
    }
  });

  it('clears the fallback timer when the stream is closed', async () => {
    const p = startPage();
    const ready = p.claude.use('db');
    p.es()[0].fail();
    await p.settle();
    p.loads[0].reject(new Error('down'));
    expect(await ready).toBeNull();
    expect(p.pending(5000)).toBe(0);
  });
});
