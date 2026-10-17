import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { applyPriceOps } from '../server/priceops';
import { Store } from '../server/store';

// public/priceops.js is a plain browser script; load it the way the page does.
type Entry = Record<string, unknown> & { id: string };
type Ops = { add: Entry[]; update: Entry[]; remove: string[] };
const sandbox = { window: {} as { BinderPriceOps: { diff: (before: Entry[], after: Entry[]) => Ops } }, JSON, Map, Set };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/priceops.js'), 'utf8'), sandbox);
const { diff } = sandbox.window.BinderPriceOps;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const entry = (id: string, over: Record<string, unknown> = {}): Entry => ({ id, at: '2026-10-01T12:00:00.000Z', type: 'market', amount: 10, currency: 'CAD', date: '2026-10-01', where: '', note: '', ...over });
const daily = entry('daily', { auto: true, amount: 12.5, date: '2026-10-02', where: 'PriceCharting', note: 'Daily update' });

describe('price entries changed by id', () => {
  it('works out what the page changed in its copy of the list', () => {
    const a = entry('a'), b = entry('b'), c = entry('c');
    expect(plain(diff([a, b], [a, { ...b, amount: 20 }, c]))).toEqual({ add: [c], update: [{ ...b, amount: 20 }], remove: [] });
    expect(plain(diff([a, b], [b]))).toEqual({ add: [], update: [], remove: ['a'] });
    expect(plain(diff([], []))).toEqual({ add: [], update: [], remove: [] });
  });

  it('applies them to the list the server has now, keeping what was added meanwhile', () => {
    const a = entry('a'), b = entry('b');
    // The page read [a, b]; the daily update has added its entry since.
    const now = [a, b, daily];
    expect(applyPriceOps(now, { add: [entry('c')] })).toEqual([a, b, daily, entry('c')]);
    expect(applyPriceOps(now, { remove: ['a'] })).toEqual([b, daily]);
    expect(applyPriceOps(now, { update: [{ ...b, amount: 30 }] })).toEqual([a, { ...b, amount: 30 }, daily]);
    // An entry already there isn't added twice; one already gone is fine to remove.
    expect(applyPriceOps(now, { add: [a], remove: ['gone'] })).toEqual(now);
    // Changing an entry removed meanwhile would bring it back: refused.
    expect(() => applyPriceOps(now, { update: [entry('gone')] })).toThrow(/changed or removed meanwhile/);
  });
});

describe('POST /api/cards/:id/prices', () => {
  let dir: string;
  let store: Store;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-priceops-'));
    store = new Store(dir);
    app = createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../public') });
    store.set('cards', 'c1', { name: 'Lapras', number: '131', status: 'binder', binderId: null, prices: [entry('a')] });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // The page reads the card; then the daily update adds today's price before the page saves.
  const pageRead = () => plain(store.get('cards', 'c1')!.prices) as Entry[];
  const updateAdds = () => store.update('cards', 'c1', { prices: [...(store.get('cards', 'c1')!.prices as Entry[]), daily] });
  const ids = () => (store.get('cards', 'c1')!.prices as Entry[]).map((e) => e.id);

  it("adds, edits and removes entries without losing one the daily update added meanwhile", async () => {
    let seen = pageRead();
    updateAdds();
    const added = entry('mine', { type: 'paid', amount: 5 });
    const r = await request(app).post('/api/cards/c1/prices').send(diff(seen, [...seen, added])).expect(200);
    expect(r.body.prices.map((e: Entry) => e.id)).toEqual(['a', 'daily', 'mine']);
    seen = pageRead().filter((e) => e.id !== 'daily'); // the page hasn't heard of it
    await request(app).post('/api/cards/c1/prices').send(diff(seen, seen.map((e) => (e.id === 'mine' ? { ...e, amount: 6 } : e)))).expect(200);
    expect((store.get('cards', 'c1')!.prices as Entry[]).find((e) => e.id === 'mine')).toMatchObject({ amount: 6 });
    await request(app).post('/api/cards/c1/prices').send(diff(seen, seen.filter((e) => e.id !== 'a'))).expect(200);
    expect(ids()).toEqual(['daily', 'mine']);
  });

  it('logs and undoes a sale with its other fields, keeping the daily entry', async () => {
    const seen = pageRead();
    updateAdds();
    const sale = entry('sale', { type: 'mysale', amount: 40 });
    await request(app).post('/api/cards/c1/prices').send({ add: [sale], fields: { status: 'sold', sale: { priceId: 'sale', soldCAD: 40 } } }).expect(200);
    expect(store.get('cards', 'c1')).toMatchObject({ status: 'sold', sale: { priceId: 'sale' } });
    expect(ids()).toEqual(['a', 'daily', 'sale']);
    await request(app).post('/api/cards/c1/prices').send({ ...diff([...seen, sale], seen), fields: { status: 'binder', sale: null } }).expect(200);
    expect(store.get('cards', 'c1')).toMatchObject({ status: 'binder', sale: null });
    expect(ids()).toEqual(['a', 'daily']);
  });

  it('undoes a sale that names no price entry: the card comes back, its entries stay', async () => {
    store.update('cards', 'c1', { status: 'sold', sale: { soldCAD: 40 } });
    await request(app).post('/api/cards/c1/prices').send({ remove: [], fields: { status: 'binder', sale: null } }).expect(200);
    expect(store.get('cards', 'c1')).toMatchObject({ status: 'binder', sale: null });
    expect(ids()).toEqual(['a']);
  });

  it('refuses an edit of an entry removed meanwhile, the whole list in fields, and bad entries', async () => {
    await request(app).post('/api/cards/c1/prices').send({ update: [entry('gone')] }).expect(409);
    await request(app).post('/api/cards/c1/prices').send({ fields: { prices: [] } }).expect(400);
    await request(app).post('/api/cards/c1/prices').send({ add: [{ id: 'x', amount: 'lots' }] }).expect(400);
    await request(app).post('/api/cards/nope/prices').send({ add: [entry('b')] }).expect(404);
    expect(ids()).toEqual(['a']);
  });
});
