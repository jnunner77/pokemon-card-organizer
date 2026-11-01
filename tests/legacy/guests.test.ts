import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Accounts, createAccounts, createApp, createGuests, type Guests } from '../../src/compose.ts';
import { PhotoFiles as Assets } from '../../src/infrastructure/photos/photo-files.ts';
import { AdminFile as Config } from '../../src/infrastructure/admin/admin-file.ts';
import { Logger } from '../../src/infrastructure/logging/logger.ts';
import { Security } from '../../server/security.ts';
import { Store } from '../../src/infrastructure/json-store/store.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a photo')]);

let dir: string;
let clock: number;
let store: Store;
let assets: Assets;
let log: Logger;
let accounts: Accounts;
let guests: Guests;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-guests-'));
  clock = Date.parse('2026-10-05T18:00:00Z');
  store = new Store(dir);
  assets = new Assets(dir);
  log = new Logger({ dir: path.join(dir, 'logs'), stdout: false, now: () => new Date(clock) });
  accounts = createAccounts({ dataDir: dir, log, now: () => new Date(clock) });
  guests = createGuests({ store, assets, log, now: () => new Date(clock) });
  await accounts.bootstrap.execute({ envPassword: 'start password 1' });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const makeApp = (extra: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ store, assets, accounts, guests, log, config: new Config(dir), publicDir: path.join(__dirname, '../../public'), now: () => new Date(clock), ...extra });

const price = (over: Record<string, unknown>) => ({ type: 'market', amount: 10, currency: 'CAD', date: '2026-10-01', at: '2026-10-01T12:00:00Z', ...over });

/** Three listed cards (one a placeholder), one in the binder and one sold, with everything the ledger keeps. */
function seed() {
  const photo = assets.put(JPEG)!.id;
  const common = { binderId: 'b1', page: 1, owner: 'Justin', notes: 'Bought from Dave', sale: null, pricing: { source: 'pricecharting', id: 'x' } };
  store.set('binders', 'b1', { name: 'For sale', pockets: 9, owner: 'Megan' });
  store.set('cards', 'listed1', { ...common, slot: 1, name: 'Charizard ex', set: 'Obsidian Flames', setCode: 'OBF', number: '125/197', rarity: 'Double Rare', condition: 'Near Mint', artist: 'PLANETA', released: '2023-08-11', status: 'listed', imageId: photo, prices: [price({ type: 'paid', amount: 4 }), price({ amount: 20.2, auto: true, date: '2026-10-04' }), price({ type: 'listed', amount: 35 })] });
  store.set('cards', 'listed2', { ...common, slot: 2, name: 'Umbreon VMAX', set: 'Evolving Skies', number: '215/203', grader: 'PSA', grade: '10', status: 'listed', imageId: 'data:image/png;base64,' + Buffer.from('png bytes').toString('base64'), prices: [price({ amount: 1000, currency: 'USD', type: 'comp' })] });
  store.set('cards', 'ph', { ...common, slot: 3, name: 'Mew', status: 'listed', placeholder: true, prices: [] });
  store.set('cards', 'kept', { ...common, slot: 4, name: 'Lapras', status: 'binder', imageId: assets.put(JPEG)!.id, prices: [price({})] });
  store.set('cards', 'gone', { ...common, slot: 5, name: 'Pikachu', status: 'sold', prices: [price({})] });
  store.set('settings', 'main', { usdToCad: 1.37 });
}

async function signInAdmin(app: ReturnType<typeof makeApp>) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'start password 1' }).expect(200);
  return agent;
}

async function guest(app: ReturnType<typeof makeApp>, name: string, contact: string, key?: string) {
  key ??= (await guests.viewing.execute()).key;
  const agent = request.agent(app);
  const r = await agent.post('/api/guest/login').send({ key, name, contact });
  return { agent, r };
}

/** A guest page's live updates (GET /api/guest/events): the lists of cards as they arrive. */
async function listen(app: ReturnType<typeof makeApp>, loginResponse: request.Response) {
  const cookie = String(loginResponse.headers['set-cookie']?.[0] ?? '').split(';')[0];
  const server = app.listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  const { port } = server.address() as AddressInfo;
  const res = await new Promise<http.IncomingMessage>((ok, bad) => http.get({ host: '127.0.0.1', port, path: '/api/guest/events', headers: { cookie } }, ok).on('error', bad));
  const lists: { id: string; value: number | null; place: { binder: string } | null }[][] = [];
  let ended = false;
  let buf = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = /^data: (.*)$/m.exec(block);
      if (/^event: cards$/m.test(block) && data) lists.push(JSON.parse(data[1]));
    }
  });
  res.on('end', () => (ended = true));
  return {
    status: res.statusCode,
    lists,
    ended: () => ended,
    ids: (n: number) => lists[n].map((c) => c.id).sort(),
    close() {
      res.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What Administration → Guests shows: who is looking and the guest log. */
const overview = (g: Guests = guests) => g.overview.execute({ linkFor: (key) => key });

describe('guest viewing', () => {
  it('shows a signed-in guest the cards listed for sale, and nothing else in the ledger', async () => {
    seed();
    const app = makeApp();
    const admin = await signInAdmin(app);
    // Off until an administrator turns it on.
    expect((await guest(app, 'Ash', 'ash@pallet.town')).r.status).toBe(403);
    await admin.put('/api/admin/guests').send({ enabled: true }).expect(200);
    expect((await guest(app, 'Ash', 'ash@pallet.town', 'wrong key')).r.body.code).toBe('guest_key');

    const { agent, r } = await guest(app, 'Ash', 'ash@pallet.town');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cards = (await agent.get('/api/guest/cards').expect(200)).body.cards;
    expect(cards.map((c: { id: string }) => c.id).sort()).toEqual(['listed1', 'listed2']);
    const zard = cards.find((c: { id: string }) => c.id === 'listed1');
    expect(zard).toMatchObject({ name: 'Charizard ex', setCode: 'OBF', number: '125/197', condition: 'Near Mint', artist: 'PLANETA', released: '2023-08-11', value: 21 });
    expect(cards.find((c: { id: string }) => c.id === 'listed2')).toMatchObject({ grader: 'PSA', grade: '10', value: 1370 });
    const body = JSON.stringify(cards);
    for (const secret of ['Dave', 'Justin', 'Megan', 'paid', 'pricecharting']) expect(body).not.toContain(secret);
    expect(zard.place).toEqual({ binderId: 'b1', binder: 'For sale', color: null, kind: 'binder', order: 0, pockets: 9, page: 1, pocket: 1 });

    // The binder's Hide from guests switch is a true or false.
    await admin.put('/api/docs/binders/b1').send({ name: 'For sale', hiddenFromGuests: 'yes' }).expect(400);

    // Pictures: listed cards only, inline photos too.
    await agent.get('/' + zard.image).expect(200).expect('content-type', /jpeg/);
    await agent.get('/api/guest/cards/listed2/image').expect(200).expect('content-type', /png/);
    await agent.get('/api/guest/cards/kept/image').expect(404);
    await agent.get('/api/guest/cards/gone/image').expect(404);

    // The ledger itself stays closed.
    await agent.get('/api/data').expect(401);
    await agent.get('/api/events').expect(401);
    await agent.get(`/blob/${store.get('cards', 'kept')!.imageId}`).expect(401);
    await agent.put('/api/docs/cards/listed1').send({ name: 'x' }).expect(401);
    await agent.get('/api/admin/guests').expect(401);
    expect((await agent.get('/').expect(302)).headers.location).toBe('login.html');
    expect((await agent.get('/admin.html').expect(302)).headers.location).toBe('login.html');

    // Without signing in: nothing.
    await request(app).get('/api/guest/cards').expect(401);
    await request(app).get('/api/guest/cards/listed1/image').expect(401);
    await request(app).get('/guest.html').expect(200);

    // Signing out ends it.
    await agent.post('/api/guest/logout').expect(204);
    await agent.get('/api/guest/cards').expect(401);
  });

  it('shows the price set for guests to the cent, and the market value once it is cleared', async () => {
    seed();
    const app = makeApp();
    const admin = await signInAdmin(app);
    await admin.put('/api/admin/guests').send({ enabled: true }).expect(200);
    const { agent } = await guest(app, 'Ash', 'ash@pallet.town');
    const valueOf = async () => (await agent.get('/api/guest/cards').expect(200)).body.cards.find((c: { id: string }) => c.id === 'listed1').value;
    await admin.patch('/api/docs/cards/listed1').send({ guestPrice: 2.5 }).expect(200);
    expect(await valueOf()).toBe(2.5);
    await admin.patch('/api/docs/cards/listed1').send({ guestPrice: 3 }).expect(200);
    expect(await valueOf()).toBe(3);
    await admin.patch('/api/docs/cards/listed1').send({ guestPrice: 0 }).expect(400);
    await admin.patch('/api/docs/cards/listed1').send({ guestPrice: 2.555 }).expect(400);
    expect(await valueOf()).toBe(3);
    await admin.patch('/api/docs/cards/listed1').send({ guestPrice: null }).expect(200);
    expect(await valueOf()).toBe(21);
  });

  it('lets several guests in at once, each with their own name and contact', async () => {
    const app = makeApp();
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    const ash = await guest(app, 'Ash Ketchum', '604-555-0199');
    expect(ash.r.status).toBe(200);
    expect((await guest(app, 'Misty', 'misty@cerulean.gym')).r.status).toBe(200);
    // Same name, other contact; same contact, other name: refused while Ash is looking.
    const sameName = await guest(app, 'ash  ketchum', 'other@mail.com');
    expect(sameName.r.status).toBe(409);
    expect(sameName.r.body.error).toMatch(/name/);
    const sameContact = await guest(app, 'Gary', '+1 (604) 555 0199');
    expect(sameContact.r.status).toBe(409);
    expect(sameContact.r.body.error).toMatch(/phone number/);
    // Ash again (another device): carries on, and the old one is signed out.
    const again = await guest(app, 'Ash Ketchum', '6045550199');
    expect(again.r.status).toBe(200);
    await again.agent.get('/api/guest/cards').expect(200);
    await ash.agent.get('/api/guest/cards').expect(401);
    expect((await overview()).active.map((g) => g.name).sort()).toEqual(['Ash Ketchum', 'Misty']);
    // Once Ash signs out, the name is free.
    await again.agent.post('/api/guest/logout').expect(204);
    expect((await guest(app, 'Ash Ketchum', 'other@mail.com')).r.status).toBe(200);
  });

  it('signs a guest out after 15 minutes without use', async () => {
    const app = makeApp();
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    const { agent } = await guest(app, 'Brock', 'brock@pewter.gym');
    clock += 14 * 60_000;
    await agent.post('/api/guest/ping').expect(200); // used it: another 15 minutes
    clock += 14 * 60_000;
    // The page's background check doesn't count as use.
    expect((await agent.get('/api/guest/me').expect(200)).body.guest).toMatchObject({ name: 'Brock' });
    clock += 60_000;
    expect((await agent.get('/api/guest/me').expect(200)).body.guest).toBeNull();
    expect((await agent.get('/api/guest/cards').expect(401)).body.code).toBe('guest_signin');
    // They can sign in again, and the log has both visits.
    expect((await guest(app, 'Brock', 'brock@pewter.gym')).r.status).toBe(200);
    const visits = (await overview()).log;
    expect(visits.map((v) => v.ended)).toEqual([null, 'timeout']);
    expect(visits[1].endedAt).toBe(new Date(Date.parse('2026-10-05T18:29:00Z')).toISOString());
  });

  it('tells the page whether guest viewing is open and the QR code still works', async () => {
    const app = makeApp();
    const key = (await guests.viewing.execute()).key;
    expect((await request(app).get(`/api/guest/me?k=${key}`)).body).toMatchObject({ open: false, keyOk: true, idleMinutes: 15, guest: null });
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    expect((await request(app).get('/api/guest/me?k=nope')).body).toMatchObject({ open: true, keyOk: false });
  });
});

describe("guests' live updates", () => {
  it('push the cards guests see to their open page as soon as they change', async () => {
    seed();
    const app = makeApp();
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    const { agent, r } = await guest(app, 'Ash', 'ash@pallet.town');
    const live = await listen(app, r);
    try {
      expect(live.status).toBe(200);
      // On connecting: the list as it is now.
      await until(() => live.lists.length === 1);
      expect(live.ids(0)).toEqual(['listed1', 'listed2']);

      // Changes guests can't see send nothing.
      store.update('cards', 'kept', { notes: 'trade bait', page: 2 });
      store.update('binders', 'b1', { owner: 'Justin' });
      await pause(400);
      expect(live.lists.length).toBe(1);

      // Renaming a binder that holds a listed card: sent.
      store.update('binders', 'b1', { name: 'Trade binder' });
      await until(() => live.lists.length === 2);
      expect(live.lists[1].find((c) => c.id === 'listed1')?.place).toMatchObject({ binderId: 'b1', binder: 'Trade binder', page: 1, pocket: 1 });
      // Hidden from guests: the cards stay, without their place.
      store.update('binders', 'b1', { hiddenFromGuests: true });
      await until(() => live.lists.length === 3);
      expect(live.ids(2)).toEqual(['listed1', 'listed2']);
      expect(live.lists[2].every((c) => c.place === null)).toBe(true);
      expect(JSON.stringify(live.lists[2])).not.toContain('Trade binder');
      // Nothing about a hidden binder reaches them.
      store.update('binders', 'b1', { name: 'Secret' });
      await pause(400);
      expect(live.lists.length).toBe(3);
      store.update('binders', 'b1', { hiddenFromGuests: false });
      await until(() => live.lists.length === 4);
      expect(live.lists[3].find((c) => c.id === 'listed1')?.place).toMatchObject({ binder: 'Secret', page: 1, pocket: 1 });

      // Listed, sold, repriced: sent right away, still only what guests see.
      store.update('cards', 'kept', { status: 'listed' });
      await until(() => live.lists.length === 5);
      expect(live.ids(4)).toEqual(['kept', 'listed1', 'listed2']);
      expect(JSON.stringify(live.lists[4])).not.toMatch(/Justin|Megan|Dave|trade bait/);
      store.update('cards', 'listed1', { status: 'sold' });
      await until(() => live.lists.length === 6);
      expect(live.ids(5)).toEqual(['kept', 'listed2']);
      store.update('settings', 'main', { usdToCad: 1.5 });
      await until(() => live.lists.length === 7);
      expect(live.lists[6].find((c) => c.id === 'listed2')?.value).toBe(1500);
      // Several changes at once arrive as one list.
      store.update('cards', 'kept', { status: 'binder' });
      store.update('cards', 'listed1', { status: 'listed' });
      await until(() => live.lists.length === 8);
      await pause(400);
      expect(live.lists.length).toBe(8);
      expect(live.ids(7)).toEqual(['listed1', 'listed2']);
      await agent.get('/api/guest/cards').expect(200);
    } finally {
      live.close();
    }
  });

  it("don't count as use, and stop when the visit ends", async () => {
    seed();
    const app = makeApp();
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    const { agent, r } = await guest(app, 'Misty', 'misty@cerulean.gym');
    clock += 10 * 60_000;
    const live = await listen(app, r);
    try {
      await until(() => live.lists.length === 1);
      clock += 6 * 60_000; // 16 minutes since Misty last used the page
      expect((await agent.get('/api/guest/me').expect(200)).body.guest).toBeNull();
      store.update('cards', 'kept', { status: 'listed' });
      await until(() => live.ended());
      expect(live.lists.length).toBe(1);
    } finally {
      live.close();
    }
  });

  it('are for signed-in guests only', async () => {
    seed();
    const app = makeApp();
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    await request(app).get('/api/guest/events').expect(401);
    const admin = await signInAdmin(app);
    await admin.get('/api/guest/events').expect(401);
  });
});

describe('administering guests', () => {
  it('turns guest viewing on and off, makes new QR codes, ends visits and keeps a log', async () => {
    seed();
    const app = makeApp();
    const admin = await signInAdmin(app);
    await admin.put('/api/admin/guests').send({ enabled: true }).expect(200);
    const oldKey = (await guests.viewing.execute()).key;
    const misty = await guest(app, 'Misty', 'misty@cerulean.gym');
    const brock = await guest(app, 'Brock', '604 555 0100');

    const g = (await admin.get('/api/admin/guests?base=' + encodeURIComponent('http://127.0.0.1/sub/admin.html')).expect(200)).body;
    expect(g).toMatchObject({ enabled: true, listed: 2, idleMinutes: 15 });
    expect(g.qr).toMatch(/^<svg/);
    expect(g.active.map((x: { name: string }) => x.name).sort()).toEqual(['Brock', 'Misty']);
    expect(g.log[0]).toMatchObject({ name: 'Brock', contact: '604 555 0100', contactKind: 'phone', ended: null });
    // A base on another site is ignored.
    const evil = (await admin.get('/api/admin/guests?base=' + encodeURIComponent('https://evil.example/')).expect(200)).body;
    expect(evil.url).not.toContain('evil.example');

    // A new QR code: the old one stops working, guests already in stay.
    await admin.post('/api/admin/guests/key').expect(204);
    expect((await guest(app, 'Gary', 'gary@oak.lab', oldKey)).r.body.code).toBe('guest_key');
    await misty.agent.get('/api/guest/cards').expect(200);

    // End one visit; then close guest viewing, which signs everyone out.
    const brockId = g.active.find((x: { name: string }) => x.name === 'Brock').id;
    await admin.delete(`/api/admin/guests/sessions/${brockId}`).expect(204);
    await brock.agent.get('/api/guest/cards').expect(401);
    await admin.put('/api/admin/guests').send({ enabled: false }).expect(200);
    await misty.agent.get('/api/guest/cards').expect(401);
    const after = (await admin.get('/api/admin/guests').expect(200)).body;
    expect(after.active).toEqual([]);
    expect(Object.fromEntries(after.log.map((v: { name: string; ended: string }) => [v.name, v.ended]))).toEqual({ Brock: 'admin', Misty: 'closed' });

    expect((await admin.delete('/api/admin/guests/log').expect(200)).body.removed).toBe(2);
    expect((await admin.get('/api/admin/guests').expect(200)).body.log).toEqual([]);
  });

  it('is for administrators only, and keeps guests out of backups', async () => {
    seed();
    const app = makeApp();
    const admin = await signInAdmin(app);
    await admin.post('/api/admin/users').send({ username: 'brock', name: 'Brock', role: 'editor', password: 'a good password', mustChange: false }).expect(201);
    const editor = request.agent(app);
    await editor.post('/api/auth/login').send({ username: 'brock', password: 'a good password' }).expect(200);
    await editor.get('/api/admin/guests').expect(403);
    await editor.put('/api/admin/guests').send({ enabled: true }).expect(403);

    await guests.setViewing.execute({ actor: 'test', enabled: true });
    await guest(app, 'Misty', 'misty@cerulean.gym');
    const backup = JSON.stringify((await admin.get('/api/backup').expect(200)).body);
    expect(backup).not.toContain('cerulean');
    expect(fs.statSync(path.join(dir, 'guests.json')).mode & 0o077).toBe(0);
  });

  it('keeps the log and settings across restarts, closing visits that were open', async () => {
    const app = makeApp();
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    await guest(app, 'Misty', 'misty@cerulean.gym');
    const again = createGuests({ store, assets, log, now: () => new Date(clock) });
    expect((await again.viewing.execute()).enabled).toBe(true);
    expect((await overview(again)).log[0]).toMatchObject({ name: 'Misty', ended: 'restart' });
    expect((await overview(again)).active).toEqual([]);
  });
});

describe('guests behind one address', () => {
  it("get their own limits, so a card show's Wi-Fi doesn't get blocked", async () => {
    seed();
    const security = new Security({ ip: { burst: 20, perMinute: 1 } }, log, () => clock);
    const app = makeApp({ security });
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    const people = [];
    for (let i = 0; i < 8; i++) {
      const { agent, r } = await guest(app, `Trainer ${i}`, `trainer${i}@league.org`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      people.push(agent);
    }
    // 8 guests × 5 requests is far past the address's 20, but each guest has their own allowance.
    for (const agent of people) for (let i = 0; i < 5; i++) await agent.get('/api/guest/cards').expect(200);
    expect(security.listBans()).toEqual([]);
  });

  it('can all keep their page updating live', async () => {
    seed();
    const security = new Security({ streamsPerIp: 2 }, log, () => clock);
    const app = makeApp({ security });
    await guests.setViewing.execute({ actor: 'test', enabled: true });
    const open = [];
    try {
      for (let i = 0; i < 4; i++) {
        const { r } = await guest(app, `Trainer ${i}`, `trainer${i}@league.org`);
        const live = await listen(app, r);
        open.push(live);
        expect(live.status).toBe(200);
      }
    } finally {
      for (const live of open) live.close();
    }
  });
});
