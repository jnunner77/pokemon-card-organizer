import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { BACKUP_FORMAT } from '../server/backup';
import { Store } from '../server/store';

// Smallest valid JPEG header bytes are enough: photos are recognised by their first bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);

let dir: string;
let store: Store;
let assets: Assets;
let app: ReturnType<typeof createApp>;

const card = (over: Record<string, unknown> = {}) => ({
  name: 'Lapras',
  set: '30th Celebration',
  setCode: '30C',
  number: '131/128',
  rarity: 'Illustration Rare',
  status: 'binder',
  prices: [{ id: 'p1', at: '2026-09-25T23:12:39.426Z', type: 'market', amount: 21.2, currency: 'CAD', date: '2026-09-25', where: 'PriceCharting', note: '' }],
  imageId: null,
  binderId: 'b1',
  page: 1,
  slot: 2,
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-'));
  store = new Store(dir);
  assets = new Assets(dir);
  app = createApp({ store, assets, publicDir: path.join(__dirname, '../public') });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('documents', () => {
  it('creates, merges, lists and deletes', async () => {
    await request(app).put('/api/docs/binders/b1').send({ name: 'IR', color: '#F2B705', pockets: 9, order: 1 }).expect(200);
    const put = await request(app).put('/api/docs/cards/c1').send(card()).expect(200);
    expect(put.body).toMatchObject({ id: 'c1', name: 'Lapras', page: 1 });

    const patched = await request(app).patch('/api/docs/cards/c1').send({ status: 'sold', binderId: null, page: null, slot: null, sale: { soldCAD: 30, profit: 8.8 } }).expect(200);
    expect(patched.body).toMatchObject({ name: 'Lapras', status: 'sold', binderId: null, sale: { soldCAD: 30 } });

    const all = await request(app).get('/api/data').expect(200);
    expect(all.body.binders).toEqual([{ id: 'b1', name: 'IR', color: '#F2B705', pockets: 9, order: 1 }]);
    expect(all.body.cards[0]).toMatchObject({ id: 'c1', status: 'sold' });

    await request(app).delete('/api/docs/cards/c1').expect(204);
    expect((await request(app).get('/api/data')).body.cards).toEqual([]);
  });

  it('keeps changes across restarts', async () => {
    await request(app).put('/api/docs/settings/main').send({ usdToCad: 1.41 }).expect(200);
    const again = new Store(dir);
    expect(again.get('settings', 'main')).toEqual({ usdToCad: 1.41 });
  });

  it('keeps a placeholder card, and switches it off', async () => {
    await request(app).put('/api/docs/cards/c1').send(card({ placeholder: true })).expect(200);
    expect(store.get('cards', 'c1')).toMatchObject({ placeholder: true });
    await request(app).patch('/api/docs/cards/c1').send({ placeholder: false }).expect(200);
    expect(store.get('cards', 'c1')).toMatchObject({ placeholder: false });
  });

  it('keeps a bundle sale on each of its cards, and rejects a bad one', async () => {
    const bundle = { id: 'b1', total: 18, currency: 'CAD', count: 3, split: 'value' };
    const sale = { amount: 6, currency: 'CAD', soldCAD: 6, date: '2026-10-04', bundle };
    await request(app).put('/api/docs/cards/c1').send(card({ status: 'sold', sale })).expect(200);
    expect(store.get('cards', 'c1')).toMatchObject({ sale: { bundle } });
    await request(app).put('/api/docs/cards/c2').send(card({ sale: { ...sale, bundle: { ...bundle, count: 0 } } })).expect(400);
    await request(app).put('/api/docs/cards/c2').send(card({ sale: { ...sale, bundle: { ...bundle, total: -1 } } })).expect(400);
  });

  it('keeps fields it does not know about', async () => {
    await request(app).put('/api/docs/cards/c1').send(card({ futureField: { a: 1 } })).expect(200);
    expect(store.get('cards', 'c1')?.futureField).toEqual({ a: 1 });
  });

  it('rejects bad writes', async () => {
    await request(app).put('/api/docs/cards/c1').send(card({ page: 0 })).expect(400);
    await request(app).put('/api/docs/cards/c1').send(card({ prices: [{ type: 'market', amount: -1, currency: 'CAD' }] })).expect(400);
    await request(app).put('/api/docs/binders/b1').send({ color: 'red' }).expect(400); // no name
    await request(app).put('/api/docs/users/u1').send({}).expect(404);
    await request(app).put('/api/docs/cards/bad%20id').send(card()).expect(400);
    await request(app).patch('/api/docs/cards/missing').send({ name: 'x' }).expect(404);
    await request(app).put('/api/docs/cards/c1').send(card({ placeholder: 'yes' })).expect(400);
    const r = await request(app).put('/api/docs/cards/c1').set('Content-Type', 'application/json').send('[1,2]').expect(400);
    expect(r.body.code).toBe('invalid_argument');
  });

  it('refuses changes from other sites', async () => {
    await request(app).put('/api/docs/cards/c1').set('Origin', 'https://evil.example').send(card()).expect(403);
    await request(app).put('/api/docs/cards/c1').set('Sec-Fetch-Site', 'cross-site').send(card()).expect(403);
    await request(app).get('/api/data').set('Sec-Fetch-Site', 'cross-site').expect(200);
  });

  it('tells subscribers about each change', async () => {
    const seen: unknown[] = [];
    store.subscribe((e) => seen.push(e));
    await request(app).put('/api/docs/cards/c1').send(card()).expect(200);
    await request(app).delete('/api/docs/cards/c1').expect(204);
    expect(seen).toEqual([
      { type: 'change', change: { collection: 'cards', id: 'c1', doc: expect.objectContaining({ name: 'Lapras' }) } },
      { type: 'change', change: { collection: 'cards', id: 'c1', doc: null } },
    ]);
  });
});

describe('sorting a binder', () => {
  const setUp = () => {
    store.set('binders', 'b1', { name: 'Trainers', pockets: 4, order: 1 });
    store.set('binders', 'b2', { name: 'Other', pockets: 9, order: 2 });
    store.set('cards', 'x', card({ page: 1, slot: 1 }));
    store.set('cards', 'y', card({ page: 1, slot: 3 }));
    store.set('cards', 'z', card({ page: 2, slot: 1 }));
    store.set('cards', 'elsewhere', card({ binderId: 'b2', page: 1, slot: 1 }));
  };
  const place = (id: string) => ({ page: store.get('cards', id)!.page, slot: store.get('cards', id)!.slot });

  it('moves every card in the binder at once, and tells open pages', async () => {
    setUp();
    const seen: string[] = [];
    store.subscribe((e) => e.type === 'change' && seen.push(e.change.id));
    const r = await request(app)
      .post('/api/binders/b1/arrange')
      .send({ moves: [{ id: 'z', page: 1, slot: 1 }, { id: 'x', page: 1, slot: 2 }, { id: 'y', page: 1, slot: 3 }] })
      .expect(200);
    expect(r.body).toEqual({ moved: 2, cards: 3 });
    expect([place('z'), place('x'), place('y')]).toEqual([{ page: 1, slot: 1 }, { page: 1, slot: 2 }, { page: 1, slot: 3 }]);
    expect(seen.sort()).toEqual(['x', 'z']); // y didn't move
    expect(place('elsewhere')).toEqual({ page: 1, slot: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).cards.z).toMatchObject({ page: 1, slot: 1 });
  });

  it('moves nothing unless the moves cover each card in the binder once, in pockets that exist', async () => {
    setUp();
    const before = ['x', 'y', 'z'].map(place);
    const tryMoves = (moves: unknown[]) => request(app).post('/api/binders/b1/arrange').send({ moves });
    // A card is missing (added meanwhile), one is from another binder, or one is twice.
    await tryMoves([{ id: 'x', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 2 }]).expect(409);
    await tryMoves([{ id: 'x', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 2 }, { id: 'elsewhere', page: 1, slot: 3 }]).expect(409);
    await tryMoves([{ id: 'x', page: 1, slot: 1 }, { id: 'x', page: 1, slot: 2 }, { id: 'y', page: 1, slot: 3 }, { id: 'z', page: 1, slot: 4 }]).expect(409);
    // Two cards in one pocket, or a pocket past the page's 4.
    await tryMoves([{ id: 'x', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 1 }, { id: 'z', page: 1, slot: 2 }]).expect(400);
    await tryMoves([{ id: 'x', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 2 }, { id: 'z', page: 1, slot: 5 }]).expect(400);
    await tryMoves([{ id: 'x', page: 0, slot: 1 }, { id: 'y', page: 1, slot: 2 }, { id: 'z', page: 1, slot: 3 }]).expect(400);
    await request(app).post('/api/binders/nope/arrange').send({ moves: [] }).expect(404);
    expect(['x', 'y', 'z'].map(place)).toEqual(before);
  });

  it("keeps the binder's own layout when asked, and only once the moves are saved", async () => {
    setUp();
    const sort = [{ id: 'z', page: 1, slot: 1 }, { id: 'x', page: 1, slot: 2 }, { id: 'y', page: 1, slot: 3 }];
    const r = await request(app).post('/api/binders/b1/arrange').send({ moves: sort, saveLayout: true }).expect(200);
    expect(r.body).toEqual({ moved: 2, cards: 3, layoutSaved: 3 });
    const layout = store.get('binders', 'b1')!.layout as { savedAt: string; places: unknown[] };
    expect(layout.places).toEqual([{ id: 'x', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 3 }, { id: 'z', page: 2, slot: 1 }]);
    expect(layout.savedAt).toMatch(/^\d{4}-/);
    expect(store.get('binders', 'b1')).toMatchObject({ name: 'Trainers', pockets: 4 });
    // Putting it back (or sorting again) without saveLayout leaves the saved layout alone.
    await request(app).post('/api/binders/b1/arrange').send({ moves: [{ id: 'x', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 3 }, { id: 'z', page: 2, slot: 1 }] }).expect(200);
    expect(store.get('binders', 'b1')!.layout).toEqual(layout);
    expect(['x', 'y', 'z'].map(place)).toEqual([{ page: 1, slot: 1 }, { page: 1, slot: 3 }, { page: 2, slot: 1 }]);
    // A refused sort doesn't replace it.
    await request(app).post('/api/binders/b1/arrange').send({ moves: sort.slice(0, 2), saveLayout: true }).expect(409);
    expect(store.get('binders', 'b1')!.layout).toEqual(layout);
    // And a damaged layout can't be saved through the documents API.
    await request(app).patch('/api/docs/binders/b1').send({ layout: { savedAt: 'x', places: [{ id: 'x', page: 0, slot: 1 }] } }).expect(400);
  });

  it('saves none of several changes when one of them is invalid', () => {
    setUp();
    expect(() => store.updateMany('cards', [{ id: 'x', patch: { page: 5 } }, { id: 'y', patch: { slot: 'nine' } }])).toThrow();
    expect(() => store.updateMany('cards', [{ id: 'x', patch: { page: 5 } }, { id: 'gone', patch: { page: 1 } }])).toThrow();
    expect(place('x')).toEqual({ page: 1, slot: 1 });
  });
});

describe("a card's owner", () => {
  it('keeps Megan, Justin, Both or blank, and refuses anything else', async () => {
    for (const owner of ['Megan', 'Justin', 'Both', '']) {
      await request(app).put('/api/docs/cards/c1').send(card({ owner })).expect(200);
      expect(store.get('cards', 'c1')!.owner).toBe(owner);
    }
    await request(app).put('/api/docs/cards/c1').send(card({ owner: 'Someone' })).expect(400);
    await request(app).patch('/api/docs/cards/c1').send({ owner: 'megan' }).expect(400);
    expect(store.get('cards', 'c1')!.owner).toBe('');
  });
});

describe('moving cards to another binder', () => {
  const setUp = () => {
    store.set('binders', 'b1', { name: 'Trainers', pockets: 4, order: 1 });
    store.set('binders', 'b2', { name: 'Other', pockets: 9, order: 2 });
    store.set('cards', 'x', card({ page: 1, slot: 1 }));
    store.set('cards', 'y', card({ page: 1, slot: 2 }));
    store.set('cards', 'z', card({ binderId: 'b2', page: 1, slot: 1 }));
  };
  const at = (id: string) => { const c = store.get('cards', id)!; return { binderId: c.binderId, page: c.page, slot: c.slot }; };
  const place = (moves: unknown[]) => request(app).post('/api/cards/place').send({ moves });

  it('moves cards to their new binder and pockets at once, leaving the old pockets empty', async () => {
    setUp();
    // x goes in front of z, which shifts along to pocket 2.
    const r = await place([{ id: 'x', binderId: 'b2', page: 1, slot: 1 }, { id: 'z', binderId: 'b2', page: 1, slot: 2 }]).expect(200);
    expect(r.body).toEqual({ moved: 2 });
    expect([at('x'), at('y'), at('z')]).toEqual([{ binderId: 'b2', page: 1, slot: 1 }, { binderId: 'b1', page: 1, slot: 2 }, { binderId: 'b2', page: 1, slot: 2 }]);
    // Undo: the old places back; out of a binder works too.
    await place([{ id: 'x', binderId: 'b1', page: 1, slot: 1 }, { id: 'z', binderId: 'b2', page: 1, slot: 1 }]).expect(200);
    await place([{ id: 'y', binderId: null, page: null, slot: null }]).expect(200);
    expect([at('x'), at('y'), at('z')]).toEqual([{ binderId: 'b1', page: 1, slot: 1 }, { binderId: null, page: null, slot: null }, { binderId: 'b2', page: 1, slot: 1 }]);
  });

  it('moves nothing when a pocket is taken, the binder or a card is gone, or the pocket is past the page', async () => {
    setUp();
    await place([{ id: 'x', binderId: 'b2', page: 1, slot: 1 }]).expect(409); // z is there
    await place([{ id: 'x', binderId: 'b2', page: 2, slot: 1 }, { id: 'y', binderId: 'b2', page: 2, slot: 1 }]).expect(409);
    await place([{ id: 'x', binderId: 'nope', page: 1, slot: 1 }]).expect(409);
    await place([{ id: 'gone', binderId: 'b2', page: 1, slot: 5 }]).expect(409);
    await place([{ id: 'x', binderId: 'b1', page: 1, slot: 5 }]).expect(400); // 4-pocket pages
    await place([{ id: 'x', binderId: 'b2', page: 1, slot: 5 }, { id: 'x', binderId: 'b2', page: 1, slot: 6 }]).expect(400);
    await place([]).expect(400);
    expect([at('x'), at('y'), at('z')]).toEqual([{ binderId: 'b1', page: 1, slot: 1 }, { binderId: 'b1', page: 1, slot: 2 }, { binderId: 'b2', page: 1, slot: 1 }]);
  });

  it('puts cards in a display case with no page or pocket, and back into a binder', async () => {
    setUp();
    store.set('binders', 'case', { name: 'Show case', kind: 'case', order: 3 });
    await place([{ id: 'x', binderId: 'case', page: null, slot: null }, { id: 'z', binderId: 'case', page: null, slot: null }]).expect(200);
    expect([at('x'), at('z')]).toEqual([{ binderId: 'case', page: null, slot: null }, { binderId: 'case', page: null, slot: null }]);
    // A case has no pockets, and a binder needs one.
    await place([{ id: 'y', binderId: 'case', page: 1, slot: 1 }]).expect(400);
    await place([{ id: 'y', binderId: 'b1', page: null, slot: null }]).expect(400);
    // Undo puts them back in their pockets.
    await place([{ id: 'x', binderId: 'b1', page: 1, slot: 1 }, { id: 'z', binderId: 'b2', page: 1, slot: 1 }]).expect(200);
    expect([at('x'), at('y'), at('z')]).toEqual([{ binderId: 'b1', page: 1, slot: 1 }, { binderId: 'b1', page: 1, slot: 2 }, { binderId: 'b2', page: 1, slot: 1 }]);
  });

  it("won't arrange a display case's cards into pockets", async () => {
    store.set('binders', 'case', { name: 'Show case', kind: 'case' });
    store.set('cards', 'x', card({ binderId: 'case', page: null, slot: null }));
    await request(app).post('/api/binders/case/arrange').send({ moves: [{ id: 'x', page: 1, slot: 1 }] }).expect(400);
  });

  it('keeps a binder type that is binder or case', async () => {
    await request(app).put('/api/docs/binders/c').send({ name: 'Show case', kind: 'case' }).expect(200);
    await request(app).put('/api/docs/binders/d').send({ name: 'Odd', kind: 'box' }).expect(400);
  });
});

describe('photos', () => {
  it('stores, serves and deletes a photo', async () => {
    const up = await request(app).post('/api/assets').set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
    expect(up.body).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), type: 'image/jpeg' });
    const img = await request(app).get(`/blob/${up.body.id}`).expect(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('immutable');
    await request(app).delete(`/api/assets/${up.body.id}`).expect(204);
    await request(app).get(`/blob/${up.body.id}`).expect(404);
  });

  it('checks the bytes, not the claimed type', async () => {
    const r = await request(app).post('/api/assets').set('Content-Type', 'image/jpeg').send(Buffer.from('<svg onload=alert(1)>')).expect(415);
    expect(r.body.code).toBe('unsupported_type');
    const png = await request(app).post('/api/assets').set('Content-Type', 'application/octet-stream').send(PNG).expect(201);
    expect(png.body.type).toBe('image/png');
  });

  it('keeps a photo that a card still shows', async () => {
    const { body } = await request(app).post('/api/assets').set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
    await request(app).put('/api/docs/cards/c1').send(card({ imageId: body.id })).expect(200);
    await request(app).delete(`/api/assets/${body.id}`).expect(204);
    await request(app).get(`/blob/${body.id}`).expect(200);
  });

  it('never serves files outside the photo folder', async () => {
    await request(app).get('/blob/..%2Fdb.json').expect(404);
    await request(app).get('/blob/../db.json').expect(404);
  });
});

describe('backups', () => {
  it('round-trips every document and photo', async () => {
    const { body: photo } = await request(app).post('/api/assets').set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
    await request(app).put('/api/docs/binders/b1').send({ name: 'IR', color: '#F2B705', pockets: 9, order: 1 }).expect(200);
    await request(app).put('/api/docs/cards/c1').send(card({ imageId: photo.id })).expect(200);
    await request(app).put('/api/docs/cards/c2').send(card({ name: 'Inline', imageId: 'data:image/jpeg;base64,AAAA', binderId: null, page: null, slot: null })).expect(200);
    await request(app).put('/api/docs/settings/main').send({ usdToCad: 1.37 }).expect(200);

    const backup = await request(app).get('/api/backup').expect(200);
    expect(backup.headers['content-disposition']).toMatch(/attachment; filename="binder-ledger-backup-/);
    expect(backup.body.format).toBe(BACKUP_FORMAT);

    // Restore into a brand-new server.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-'));
    try {
      const app2 = createApp({ store: new Store(dir2), assets: new Assets(dir2) });
      const r = await request(app2).post('/api/restore').send(backup.body).expect(200);
      expect(r.body).toEqual({ binders: 1, cards: 2, photos: 1, missingPhotos: 0 });
      const [a, b] = await Promise.all([request(app).get('/api/data'), request(app2).get('/api/data')]);
      expect(b.body).toEqual(a.body);
      const img = await request(app2).get(`/blob/${photo.id}`).expect(200);
      expect(Buffer.compare(img.body, JPEG)).toBe(0);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('keeps the old ledger when a restore replaces it', async () => {
    await request(app).put('/api/docs/cards/old').send(card()).expect(200);
    const backup = { format: BACKUP_FORMAT, version: 1, binders: {}, cards: { c9: card({ name: 'Mew' }) }, settings: {}, assets: {} };
    const events: unknown[] = [];
    store.subscribe((e) => events.push(e));
    await request(app).post('/api/restore').send(backup).expect(200);
    expect(store.all().cards.map((c) => c.id)).toEqual(['c9']);
    expect(events).toEqual([{ type: 'reset' }]);
    const kept = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('db-before-restore-'));
    expect(kept).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'backups', kept[0]), 'utf8')).cards.old.name).toBe('Lapras');
  });

  it('changes nothing when the backup is bad', async () => {
    await request(app).put('/api/docs/cards/old').send(card()).expect(200);
    const bad = { format: BACKUP_FORMAT, version: 1, binders: {}, cards: { c1: card({ slot: -3 }) }, settings: {}, assets: {} };
    const r = await request(app).post('/api/restore').send(bad).expect(400);
    expect(r.body.error).toMatch(/^cards\.c1/);
    await request(app).post('/api/restore').send({ hello: 'world' }).expect(400);
    const badPhoto = { format: BACKUP_FORMAT, version: 1, binders: {}, cards: {}, settings: {}, assets: { ['a'.repeat(32)]: { type: 'image/jpeg', data: Buffer.from('nope').toString('base64') } } };
    await request(app).post('/api/restore').send(badPhoto).expect(400);
    expect(store.all().cards.map((c) => c.id)).toEqual(['old']);
  });
});

describe('page', () => {
  it('serves the page with a strict content security policy', async () => {
    const r = await request(app).get('/').expect(200);
    expect(r.text).toContain('Pokémon Binder Ledger');
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    await request(app).get('/runtime.js').expect(200);
    await request(app).get('/fonts/archivo/wdth.css').expect(200);
  });
});
