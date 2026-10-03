import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { Auth } from '../server/auth';
import { chooseMatch, searchQuery } from '../server/pricing/match';
import { type Candidate, type Fetcher, parsePriceChartingProduct, parsePriceChartingSearch, parseTcgplayerSearch, pickTcgPrice } from '../server/pricing/sources';
import { PriceUpdater } from '../server/pricing/updater';
import { Store } from '../server/store';

const fixture = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a card image')]);
const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('another card image')]);

const tcgSearch = {
  results: [
    {
      results: [
        { productId: 696683.0, productName: 'Lapras - 131/128', setName: 'ME: 30th Celebration', marketPrice: 7.7312, customAttributes: { number: '131/128' } },
        { productId: 517045.0, productName: 'Lapras - 131/165', setName: 'SV: Scarlet & Violet 151', marketPrice: 0.21, customAttributes: { number: '131/165' } },
      ],
    },
  ],
};
const tcgPoints = [
  { printingType: 'Normal', marketPrice: null, buylistMarketPrice: null, listedMedianPrice: null },
  { printingType: 'Foil', marketPrice: 7.73, buylistMarketPrice: null, listedMedianPrice: 11 },
];
const boc = (v: string, d = '2026-10-02') => ({ observations: [{ d, FXUSDCAD: { v } }] });

/** A stand-in for the internet: answers each URL the price code asks for and records the calls. */
function fakeNet(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const respond = (body: string | Buffer | object, url: string, type = 'text/html') => {
    const payload = Buffer.isBuffer(body) ? new Uint8Array(body) : typeof body === 'object' ? JSON.stringify(body) : body;
    const r = new Response(payload, { headers: { 'Content-Type': type } });
    Object.defineProperty(r, 'url', { value: url });
    return r;
  };
  const fetcher: Fetcher = async (input) => {
    const url = String(input);
    calls.push(url);
    for (const [k, fn] of Object.entries(overrides)) if (url.includes(k)) return fn();
    if (url.includes('bankofcanada.ca')) return respond(boc('1.4246'), url);
    // An exact search lands straight on the product page.
    if (url.includes('pricecharting.com/search-products') && url.includes('Lapras')) return respond(fixture('pricecharting-product.html'), 'https://www.pricecharting.com/game/pokemon-30th-celebration/lapras-131');
    if (url.includes('pricecharting.com/search-products')) return respond('<html><table></table></html>', url);
    if (url.includes('pricecharting.com/game/')) return respond(fixture('pricecharting-product.html'), url);
    if (url.includes('mp-search-api.tcgplayer.com')) return respond({ results: [{ results: [] }] }, url);
    if (url.includes('/pricepoints')) return respond(tcgPoints, url);
    if (url.endsWith('/1600.jpg') || url.endsWith('_in_1000x1000.jpg')) return respond(JPEG, url, 'image/jpeg');
    return new Response('not found', { status: 404 });
  };
  return { fetcher, calls };
}

describe('reading the price sites', () => {
  it('reads a PriceCharting product page', () => {
    const p = parsePriceChartingProduct(fixture('pricecharting-product.html'), '/game/pokemon-30th-celebration/lapras-131');
    expect(p).toMatchObject({ title: 'Lapras', number: '131', set: 'Pokemon 30th Celebration', usd: 13.2 });
    expect(p.image).toBe('https://storage.googleapis.com/images.pricecharting.com/asqso2to674mken7/1600.jpg');
  });

  it('reads PriceCharting search results, variants included', () => {
    const rows = parsePriceChartingSearch(fixture('pricecharting-search.html'));
    expect(rows.map((r) => [r.title, r.set, r.number, r.usd])).toEqual([
      ['Lapras', 'Pokemon 30th Celebration', '131', 13.2],
      ['Lapras', 'Pokemon Japanese Mystery of the Fossils', '131', 18.49],
      ['Lapras [Reverse Holo]', 'Pokemon Scarlet & Violet 151', '131', 2.23],
      ['Lapras', 'Pokemon Scarlet & Violet 151', '131', 1.01],
    ]);
    expect(rows[0].id).toBe('/game/pokemon-30th-celebration/lapras-131');
  });

  it('reads TCGplayer search results and prices by printing', () => {
    const [c] = parseTcgplayerSearch(tcgSearch);
    expect(c).toMatchObject({ source: 'tcgplayer', id: '696683', title: 'Lapras', set: 'ME: 30th Celebration', number: '131', usd: 7.73 });
    expect(pickTcgPrice(tcgPoints, false)).toBe(7.73); // only the foil printing has a price
    expect(pickTcgPrice([{ printingType: 'Normal', marketPrice: 1.5 }, { printingType: 'Foil', marketPrice: 4 }], true)).toBe(4);
    expect(pickTcgPrice([{ printingType: 'Normal', marketPrice: 1.5 }, { printingType: 'Foil', marketPrice: 4 }], false)).toBe(1.5);
    expect(pickTcgPrice('garbage', false)).toBeNull();
    expect(pickTcgPrice(tcgPoints, false, true)).toBeNull(); // a common's holo price isn't its price
  });
});

describe('matching a card to a product', () => {
  const pc = parsePriceChartingSearch(fixture('pricecharting-search.html'));
  const cand = (title: string, set: string, number: string, source: Candidate['source'] = 'pricecharting'): Candidate => ({ source, id: `${title}|${set}`, url: '', title, set, number, usd: 1, thumb: null });

  it('links only the English card from the same set, without a variant', () => {
    expect(chooseMatch({ name: 'Lapras', set: '30th Celebration', setCode: '30C', number: '131/128' }, pc).match?.set).toBe('Pokemon 30th Celebration');
    expect(chooseMatch({ name: 'Lapras', set: 'Scarlet & Violet 151', setCode: 'MEW', number: '131/165' }, pc).match?.title).toBe('Lapras');
    expect(chooseMatch({ name: 'Lapras', set: 'Scarlet & Violet 151', setCode: 'MEW', number: '131/165', variant: 'Reverse holo' }, pc).match?.title).toBe('Lapras [Reverse Holo]');
  });

  it('handles promos, energies, VSTAR spellings and set name differences', () => {
    expect(chooseMatch({ name: 'Oricorio EX', set: 'Mega Evolution Promos', setCode: 'MEP', number: '024' }, [cand('Oricorio EX', 'Pokemon Promo', '24')]).match).not.toBeNull();
    expect(chooseMatch({ name: 'Hisuian Zoroark V Star', set: 'Crown Zenith', setCode: 'CRZ', number: 'SWSH298' }, [cand('Hisuian Zoroark VSTAR', 'Pokemon Promo', 'SWSH298'), cand('Hisuian Zoroark VSTAR [Jumbo]', 'Pokemon Promo', 'SWSH298')]).match?.title).toBe('Hisuian Zoroark VSTAR');
    expect(chooseMatch({ name: 'Basic Fighting Energy', set: 'Scarlet & Violet Base', setCode: 'SVI', number: '258/198' }, [cand('Basic Fighting Energy', 'Pokemon Scarlet & Violet Energy', '258')]).match).not.toBeNull();
    expect(chooseMatch({ name: 'Pikachu', set: 'Pokemon McDonalds 2022', setCode: 'M22', number: '7/15' }, [cand('Pikachu', "McDonald's Promos 2022", '7', 'tcgplayer')]).match).not.toBeNull();
    expect(chooseMatch({ name: 'Pikachu', set: 'Temporal Forces', setCode: 'TEF', number: '51/162', variant: '2026 Pokemon Day' }, [cand('Pikachu', 'Pokemon Temporal Forces', '51'), cand('Pikachu [2026 Pokemon Day]', 'Pokemon Temporal Forces', '51')]).match?.title).toBe('Pikachu [2026 Pokemon Day]');
  });

  it('allows typos and suffixes, and knows Base Set from Base Set 2', () => {
    expect(chooseMatch({ name: 'Mega Eelktross EX', set: 'Ascended Heroes', number: '61/217' }, [cand('Mega Eelektross ex', 'Pokemon Ascended Heroes', '61'), cand('Mega Eelektross Ex [Prize Pack]', 'Pokemon Ascended Heroes', '61')]).match?.title).toBe('Mega Eelektross ex');
    expect(chooseMatch({ name: 'Lugia EX', set: 'Classic: Venasaur', number: '17/34' }, [cand('Lugia EX', 'Pokemon TCG Classic: Venusaur Deck', '17')]).match).not.toBeNull();
    expect(chooseMatch({ name: "Sleep! (Rocket's Secret Machine)", set: 'Pokemon Team Rocket', number: '79/82' }, [cand('Sleep! [1st Edition]', 'Pokemon Team Rocket', '79'), cand('Sleep!', 'Pokemon Team Rocket', '79')]).match?.title).toBe('Sleep!');
    expect(chooseMatch({ name: 'Pokedex', set: 'Pokemon Base Set', number: '87/102' }, [cand('Pokedex', 'Pokemon Base Set', '87'), cand('Pokedex [Shadowless]', 'Pokemon Base Set', '87'), cand('Pokedex', 'Pokemon Base Set 2', '87')]).match?.set).toBe('Pokemon Base Set');
    // Recorded as Base Set, but 118/130 is Base Set 2: the person decides.
    expect(chooseMatch({ name: 'Bill', set: 'Pokemon Base Set', number: '118/130' }, [cand('Bill', 'Pokemon Base Set 2', '118')]).match).toBeNull();
    // A different Pokémon with the same number is not a typo.
    expect(chooseMatch({ name: 'Mew', set: 'Paldean Fates', number: '232/91' }, [cand('Mewtwo', 'Pokemon Paldean Fates', '232')]).match).toBeNull();
  });

  it('leaves the choice to the person when it isn’t certain', () => {
    // Only a holo version listed: not the same as the plain card.
    const r = chooseMatch({ name: 'Pikachu', set: 'Pokemon McDonalds 2022', number: '7/15' }, [cand('Pikachu [Holo]', 'Pokemon McDonalds 2022', '7')]);
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(1);
    // Two identical-looking products.
    expect(chooseMatch({ name: 'Mew', set: 'Paldean Fates', number: '232/91' }, [cand('Mew', 'Pokemon Paldean Fates', '232'), cand('Mew', 'Pokemon Paldean Fates', '232')]).match).toBeNull();
    expect(searchQuery({ name: 'Hisuian Zoroark V Star', number: 'SWSH298' })).toBe('Hisuian Zoroark VSTAR swsh298');
  });
});

describe('the daily update', () => {
  let dir: string;
  let store: Store;
  let assets: Assets;
  let now: Date;
  const card = (over: Record<string, unknown> = {}) => ({ name: 'Lapras', set: '30th Celebration', setCode: '30C', number: '131/128', status: 'binder', prices: [], binderId: 'b1', page: 1, slot: 1, ...over });
  const updater = (fetcher: Fetcher) => new PriceUpdater({ store, assets, fetcher, now: () => now, delayMs: 0, timeZone: 'America/Vancouver' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-price-'));
    store = new Store(dir);
    assets = new Assets(dir);
    now = new Date('2026-10-03T15:00:00Z');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('links the card, logs today’s price in CAD and downloads the large image', async () => {
    store.set('cards', 'c1', card());
    const summary = await updater(fakeNet().fetcher).runAll('manual');
    expect(summary.counts.updated).toBe(1);
    expect(summary.rate).toBe(1.4246);
    const c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', linkedBy: 'auto', error: null });
    expect(c.prices).toEqual([expect.objectContaining({ type: 'market', currency: 'CAD', amount: 18.8, usd: 13.2, auto: true, date: '2026-10-03', where: 'PriceCharting' })]);
    expect(assets.find(c.officialImageId as string)).not.toBeNull();
    expect(store.get('settings', 'main')).toMatchObject({ usdToCad: 1.4246 });
    expect(store.get('settings', 'pricing')).toMatchObject({ running: false, lastRun: { date: '2026-10-03', counts: { updated: 1 } } });
  });

  it('keeps one automatic price a day for 30 days and never touches the person’s own entries', async () => {
    const old = (date: string, amount: number) => ({ id: date, type: 'market', amount, currency: 'CAD', date, auto: true });
    store.set('cards', 'c1', card({
      pricing: { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131' },
      prices: [old('2026-08-01', 10), old('2026-09-02', 11), old('2026-09-03', 12), old('2026-10-03', 13), { id: 'paid', type: 'paid', amount: 5, currency: 'CAD', date: '2025-01-01' }, { id: 'mine', type: 'market', amount: 30, currency: 'CAD', date: '2026-01-01' }],
    }));
    await updater(fakeNet().fetcher).runAll('manual');
    await updater(fakeNet().fetcher).runAll('manual'); // a second run the same day replaces today's entry
    const dates = (store.get('cards', 'c1')!.prices as { id: string; date: string; auto?: boolean }[]).map((p) => (p.auto ? p.date : p.id));
    expect(dates).toEqual(['2026-09-03', 'paid', 'mine', '2026-10-03']);
  });

  it('leaves sold cards, cards with pricing turned off, and uncertain matches alone', async () => {
    store.set('cards', 'sold', card({ status: 'sold' }));
    store.set('cards', 'off', card({ pricing: { source: 'off' } }));
    store.set('cards', 'odd', card({ name: 'Mystery', number: '999/1' }));
    const s = await updater(fakeNet().fetcher).runAll('manual');
    expect(s.counts).toMatchObject({ skipped: 1, off: 1, needsMatch: 1, updated: 0 });
    expect(store.get('cards', 'sold')!.prices).toEqual([]);
    expect(store.get('cards', 'odd')!.pricing).toMatchObject({ source: 'none' });
  });

  it('records a failure and carries on with the next card', async () => {
    store.set('cards', 'a', card({ pricing: { source: 'pricecharting', id: '/game/x/broken' } }));
    store.set('cards', 'b', card());
    const net = fakeNet({ '/game/x/broken': () => new Response('gone', { status: 404 }), 'bankofcanada.ca': () => new Response('down', { status: 400 }) });
    store.set('settings', 'main', { usdToCad: 1.4 });
    const s = await updater(net.fetcher).runAll('manual');
    expect(s.counts).toMatchObject({ failed: 1, updated: 1 });
    expect(s.rate).toBe(1.4); // the saved rate when the Bank of Canada is unreachable
    expect(s.errors[0].error).toMatch(/404/);
    expect(store.get('cards', 'a')!.pricing).toMatchObject({ error: expect.stringMatching(/404/) });
  });

  it('uses TCGplayer for a card linked there, and swaps the image when the match changes', async () => {
    store.set('cards', 'c1', card());
    const u = updater(fakeNet().fetcher);
    await u.runAll('manual');
    const firstImage = store.get('cards', 'c1')!.officialImageId as string;
    const net = fakeNet({ '_in_1000x1000.jpg': () => new Response(new Uint8Array(JPEG2)) });
    const outcome = await updater(net.fetcher).link('c1', { source: 'tcgplayer', id: '696683', url: 'https://www.tcgplayer.com/product/696683', title: 'Lapras', set: 'ME: 30th Celebration' });
    expect(outcome).toBe('updated');
    const c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'tcgplayer', linkedBy: 'user' });
    expect((c.prices as { where: string; amount: number }[]).at(-1)).toMatchObject({ where: 'TCGplayer', amount: 11.01 });
    expect(c.officialImageId).not.toBe(firstImage);
    expect(assets.find(firstImage)).toBeNull();
  });

  it('runs once a day after the set hour, catching up after downtime', () => {
    const u = new PriceUpdater({ store, assets, fetcher: fakeNet().fetcher, now: () => now, hour: 5, timeZone: 'America/Vancouver' });
    expect(u.today(new Date('2026-10-03T06:30:00Z'))).toBe('2026-10-02'); // still the 2nd in Vancouver
    expect(u.today(new Date('2026-10-03T15:00:00Z'))).toBe('2026-10-03');
  });
});

describe('pricing and sign-in over HTTP', () => {
  let dir: string;
  let store: Store;
  let assets: Assets;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-api-'));
    store = new Store(dir);
    assets = new Assets(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('searches both sites and links a chosen product', async () => {
    const net = fakeNet({ 'mp-search-api.tcgplayer.com': () => new Response(JSON.stringify(tcgSearch)) });
    const updater = new PriceUpdater({ store, assets, fetcher: net.fetcher, delayMs: 0 });
    const app = createApp({ store, assets, updater });
    store.set('cards', 'c1', { name: 'Lapras', set: '30th Celebration', number: '131/128', status: 'binder', prices: [] });
    const s = await request(app).get('/api/pricing/search?card=c1').expect(200);
    expect(s.body.candidates.map((c: Candidate) => `${c.source}:${c.title}`)).toEqual(['pricecharting:Lapras', 'tcgplayer:Lapras', 'tcgplayer:Lapras']);
    const l = await request(app).post('/api/pricing/link/c1').send({ source: 'off' }).expect(200);
    expect(l.body).toMatchObject({ outcome: 'off', card: { pricing: { source: 'off' } } });
    await request(app).post('/api/pricing/link/c1').send({ source: 'ebay', id: 'x' }).expect(400);
    await request(app).post('/api/pricing/link/nope').send({ source: 'off' }).expect(404);
    await request(app).post('/api/pricing/run').expect(202);
    await request(createApp({ store, assets })).post('/api/pricing/run').expect(503);
  });

  it('requires the password when one is set', async () => {
    const auth = new Auth(dir, 'binder pass');
    const app = createApp({ store, assets, auth, publicDir: path.join(__dirname, '../public') });
    await request(app).get('/api/data').expect(401);
    await request(app).get('/blob/' + 'a'.repeat(32)).expect(401);
    expect((await request(app).get('/').expect(302)).headers.location).toBe('login.html');
    await request(app).get('/login.html').expect(200);
    await request(app).get('/api/health').expect(200);
    await request(app).post('/api/login').send({ password: 'nope' }).expect(401);
    const agent = request.agent(app);
    await agent.post('/api/login').send({ password: 'binder pass' }).expect(200);
    await agent.get('/api/data').expect(200);
    await agent.get('/').expect(200);
    expect((await agent.get('/api/session')).body).toEqual({ required: true, signedIn: true });
    // A new password signs every browser out.
    const app2 = createApp({ store, assets, auth: new Auth(dir, 'new pass') });
    const cookie = (await request(app).post('/api/login').send({ password: 'binder pass' })).headers['set-cookie'];
    await request(app2).get('/api/data').set('Cookie', cookie).expect(401);
  });

  it('slows down password guessing', async () => {
    const app = createApp({ store, assets, auth: new Auth(dir, 'secret') });
    for (let i = 0; i < 10; i++) await request(app).post('/api/login').send({ password: 'guess' + i }).expect(401);
    await request(app).post('/api/login').send({ password: 'secret' }).expect(429);
  });
});
