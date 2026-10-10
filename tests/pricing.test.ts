import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { Config } from '../server/config';
import { Catalog, choosePtcg, printingOf, ptcgTcgplayer, tcgdexCardmarket, tcgdexTcgplayer, type PtcgCard, type TcgdexCard } from '../server/pricing/catalog';
import { chooseMatch, detailsFromProduct, searchQuery, variantFromProduct } from '../server/pricing/match';
import { type Candidate, type Fetcher, retryPolicy, parsePriceChartingProduct, parsePriceChartingSearch, parseTcgplayerDetails, parseTcgplayerSearch, pickTcgPrice, releaseDate } from '../server/pricing/sources';
import { PriceUpdater, thinAutoPrices } from '../server/pricing/updater';
import { Store } from '../server/store';

retryPolicy.baseMs = 1; // retries happen at once in tests

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

  it("reads a product's set, release date and rarity", () => {
    expect(parsePriceChartingProduct(fixture('pricecharting-product.html'), '/game/pokemon-30th-celebration/lapras-131').info).toEqual({ set: 'Pokemon 30th Celebration', released: '2026-09-16', rarity: null });
    expect(parseTcgplayerDetails({ productName: 'Mr. Mime', setName: 'Trading Card Game Classic', rarityName: 'Classic Collection', customAttributes: { releaseDate: '2023-11-17T00:00:00Z', number: '013/034' } })).toEqual({ set: 'Trading Card Game Classic', released: '2023-11-17', rarity: 'Classic Collection' });
    expect(parseTcgplayerDetails({ results: [] })).toBeNull();
    expect([releaseDate('December 1, 2023'), releaseDate('May 9, 1999'), releaseDate('Smarch 1, 2020'), releaseDate('')]).toEqual(['2023-12-01', '1999-05-09', null, null]);
  });

  it('decodes the HTML entities in product links from PriceCharting search ("Scarlet &amp; Violet")', () => {
    const row = `<table><tr id="product-1"><td class="title"> <a href="https://www.pricecharting.com/game/pokemon-scarlet-&amp;-violet-151/lapras-131">Lapras #131</a></td><td class="console"> <a href="#">Pokemon Scarlet &amp; Violet 151</a></td><td class="price numeric used_price">$1.00</td></tr></table>`;
    const [c] = parsePriceChartingSearch(row);
    expect(c).toMatchObject({ id: '/game/pokemon-scarlet-&-violet-151/lapras-131', url: 'https://www.pricecharting.com/game/pokemon-scarlet-&-violet-151/lapras-131', set: 'Pokemon Scarlet & Violet 151' });
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

  it("fills a card's blanks from its product, and follows a product the person chose from another set", () => {
    const info = { set: 'Pokemon TCG Classic: Blastoise Deck', released: '2023-12-01', rarity: 'Classic Collection' };
    expect(detailsFromProduct({ name: 'Mr. Mime', number: '013/034' }, info, true).patch).toEqual({ set: 'Pokemon TCG Classic: Blastoise Deck', released: '2023-12-01', rarity: 'Classic Collection' });
    // The person's own label for the same set, and their own rarity and date, stay.
    expect(detailsFromProduct({ set: 'Classic: Blastoise', rarity: 'Mine', released: '2023-11-17' }, info, true).filled).toEqual([]);
    // A product the person chose from another set wins; an automatic match only fills blanks.
    expect(detailsFromProduct({ set: 'Base Set', released: '1999-01-09', rarity: 'Rare' }, info, true).patch).toEqual({ set: 'Pokemon TCG Classic: Blastoise Deck' });
    expect(detailsFromProduct({ set: 'Base Set', released: '1999-01-09', rarity: 'Rare' }, info, false).filled).toEqual([]);
    // A promo label stays with any promo product.
    expect(detailsFromProduct({ set: 'Mega Evolution Promos', setCode: 'MEP', number: '101' }, { set: 'Pokemon Promo', released: '2026-09-16', rarity: null }, true).patch).toEqual({ released: '2026-09-16' });
    expect(detailsFromProduct({}, { set: null, released: null, rarity: 'Rare Holo' }, false).patch).toEqual({ rarity: 'Holo Rare' });
  });

  it('takes the variant from a product the person chose', () => {
    expect(variantFromProduct({ variant: '' }, 'Rayquaza [Ball]')).toBe('Ball');
    expect(variantFromProduct({}, 'Lapras [Reverse Holo]')).toBe('Reverse Holo');
    // A different variant gives way; one that agrees stays as the person wrote it.
    expect(variantFromProduct({ variant: 'Reverse holo' }, 'Rayquaza [Master Ball]')).toBe('Master Ball');
    expect(variantFromProduct({ variant: 'Reverse holo' }, 'Lapras [Reverse Holo]')).toBeNull();
    expect(variantFromProduct({ variant: 'Poke Ball pattern' }, 'Rayquaza [Ball]')).toBeNull();
    // A plain product changes nothing.
    expect(variantFromProduct({ variant: '30th stamp' }, 'Lapras')).toBeNull();
    expect(variantFromProduct({}, null)).toBeNull();
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

  it('keeps one automatic price a day for 30 days, one a week before that, and never touches the person’s own entries', async () => {
    const old = (date: string, amount: number) => ({ id: date, type: 'market', amount, currency: 'CAD', date, auto: true });
    store.set('cards', 'c1', card({
      pricing: { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131' },
      // 2026-08-24 to 08-30 is one week (Monday to Sunday): only its last entry stays
      prices: [old('2026-08-01', 10), old('2026-08-24', 10.5), old('2026-08-27', 10.7), old('2026-09-02', 11), old('2026-09-03', 12), old('2026-10-03', 13), { id: 'paid', type: 'paid', amount: 5, currency: 'CAD', date: '2025-01-01' }, { id: 'mine', type: 'market', amount: 30, currency: 'CAD', date: '2026-01-01' }],
    }));
    await updater(fakeNet().fetcher).runAll('manual');
    await updater(fakeNet().fetcher).runAll('manual'); // a second run the same day replaces today's entry
    const dates = (store.get('cards', 'c1')!.prices as { id: string; date: string; auto?: boolean }[]).map((p) => (p.auto ? p.date : p.id));
    expect(dates).toEqual(['2026-08-01', '2026-08-27', '2026-09-02', '2026-09-03', 'paid', 'mine', '2026-10-03']);
  });

  it('thins automatic prices older than the cutoff to the last of each week', () => {
    const a = (date: string | null) => ({ date, auto: true });
    const kept = thinAutoPrices([a('2026-07-06'), a('2026-07-08'), a('2026-07-12'), a('2026-07-13'), a('2026-07-13'), a(null), a('2026-09-10'), a('2026-09-11'), { date: '2026-07-07' }], '2026-10-01', '2026-09-01');
    expect(kept.map((p) => p.date)).toEqual(['2026-07-12', '2026-07-13', '2026-09-10', '2026-09-11', '2026-07-07']);
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

  it('uses TCGplayer for a card PriceCharting doesn’t list, and swaps the image when PriceCharting is chosen', async () => {
    store.set('cards', 'c1', card());
    const noPc = { 'pricecharting.com/search-products': () => new Response('<html><table></table></html>'), 'mp-search-api.tcgplayer.com/v1/search': () => Response.json(tcgSearch) };
    expect(await updater(fakeNet(noPc).fetcher).runAll('manual')).toMatchObject({ counts: { updated: 1 } });
    let c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'tcgplayer', id: '696683', linkedBy: 'auto', pair: { source: 'pricecharting', id: null } });
    expect((c.prices as { where: string; amount: number }[]).at(-1)).toMatchObject({ where: 'TCGplayer', amount: 11.01 });
    const firstImage = c.officialImageId as string;
    const net = fakeNet({ '/1600.jpg': () => new Response(new Uint8Array(JPEG2)) });
    const outcome = await updater(net.fetcher).link('c1', { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', url: 'https://www.pricecharting.com/game/pokemon-30th-celebration/lapras-131', title: 'Lapras', set: 'Pokemon 30th Celebration' });
    expect(outcome).toBe('updated');
    c = store.get('cards', 'c1')!;
    // PriceCharting is the main product now; TCGplayer's automatic match stays as its pair.
    expect(c.pricing).toMatchObject({ source: 'pricecharting', linkedBy: 'user', pair: { source: 'tcgplayer', id: '696683', linkedBy: 'auto' } });
    expect((c.prices as { where: string; usd: number; quotes: object }[]).at(-1)).toMatchObject({ where: 'PriceCharting', usd: 13.2, quotes: { pricecharting: 13.2, tcgplayer: 7.73 } });
    expect(c.officialImageId).not.toBe(firstImage);
    expect(assets.find(firstImage)).toBeNull();
  });

  it('logs the higher of the two sites’ prices, with details and image from PriceCharting', async () => {
    store.set('cards', 'c1', card());
    const high = [{ printingType: 'Foil', marketPrice: 20 }];
    const net = fakeNet({ 'mp-search-api.tcgplayer.com/v1/search': () => Response.json(tcgSearch), '/pricepoints': () => Response.json(high) });
    expect(await updater(net.fetcher).updateCard('c1')).toBe('updated');
    const c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'pricecharting', linkedBy: 'auto', error: null, pair: { source: 'tcgplayer', id: '696683', linkedBy: 'auto', error: null } });
    expect(c.prices).toEqual([expect.objectContaining({ where: 'TCGplayer', usd: 20, amount: 27.4, quotes: { pricecharting: 13.2, tcgplayer: 20 }, note: 'Daily update · higher of PriceCharting US$13.20 and TCGplayer US$20.00 at 1.3700' })]);
    // Release date from PriceCharting; TCGplayer's product details weren't asked for.
    expect(c).toMatchObject({ set: '30th Celebration', released: '2026-09-16' });
    expect(net.calls.some((u) => u.includes('/details'))).toBe(false);
    expect(net.calls.filter((u) => u.endsWith('/1600.jpg'))).toHaveLength(1);
    expect(net.calls.some((u) => u.includes('_in_1000x1000'))).toBe(false);
  });

  it('uses the site that answered when the other fails or has no price', async () => {
    const both = (over: Record<string, unknown> = {}) => card({ pricing: { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', linkedBy: 'auto', pair: { source: 'tcgplayer', id: '696683', linkedBy: 'auto' } }, ...over });
    store.set('cards', 'tcgDown', both());
    expect(await updater(fakeNet({ '/pricepoints': () => new Response('down', { status: 503 }) }).fetcher).updateCard('tcgDown')).toBe('updated');
    expect(store.get('cards', 'tcgDown')).toMatchObject({ pricing: { error: null, pair: { error: expect.stringMatching(/503/) } }, prices: [expect.objectContaining({ where: 'PriceCharting', usd: 13.2, quotes: { pricecharting: 13.2 } })] });
    store.set('cards', 'pcDown', both());
    expect(await updater(fakeNet({ 'pricecharting.com/game/': () => new Response('down', { status: 503 }) }).fetcher).updateCard('pcDown')).toBe('updated');
    expect(store.get('cards', 'pcDown')).toMatchObject({ pricing: { error: expect.stringMatching(/503/), pair: { error: null } }, prices: [expect.objectContaining({ where: 'TCGplayer', usd: 7.73 })] });
    store.set('cards', 'pcNoPrice', both());
    const noPrice = fixture('pricecharting-product.html').replace(/(id="used_price"[\s\S]*?<span class="price js-price">)[\s\S]*?(<\/span>)/, '$1-$2');
    const r = () => { const x = new Response(noPrice); Object.defineProperty(x, 'url', { value: 'https://www.pricecharting.com/game/pokemon-30th-celebration/lapras-131' }); return x; };
    expect(await updater(fakeNet({ 'pricecharting.com/game/': r }).fetcher).updateCard('pcNoPrice')).toBe('updated');
    expect(store.get('cards', 'pcNoPrice')).toMatchObject({ pricing: { error: null }, prices: [expect.objectContaining({ where: 'TCGplayer', quotes: { tcgplayer: 7.73 } })] });
    // Both down: a failure, as before.
    store.set('cards', 'allDown', both());
    expect(await updater(fakeNet({ 'pricecharting.com/game/': () => new Response('down', { status: 503 }), '/pricepoints': () => new Response('down', { status: 503 }) }).fetcher).updateCard('allDown')).toBe('failed');
    expect(store.get('cards', 'allDown')).toMatchObject({ prices: [], pricing: { error: expect.stringMatching(/pricecharting.*503/) } });
  });

  it('searches TCGplayer by name and set when name and number don’t find the card', async () => {
    store.set('cards', 'c1', card({ set: 'Pokemon 30th Celebration' }));
    const net = fakeNet({ 'q=Lapras%2030th%20celebration': () => Response.json(tcgSearch) });
    expect(await updater(net.fetcher).updateCard('c1')).toBe('updated');
    expect(net.calls.filter((u) => u.includes('mp-search-api.tcgplayer.com/v1/search')).map((u) => decodeURIComponent(u.split('q=')[1].split('&')[0]))).toEqual(['Lapras 131', 'Lapras 30th celebration']);
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ pair: { source: 'tcgplayer', id: '696683', linkedBy: 'auto' } });
  });

  it('looks for the other site’s product again only after a week, and moves a card to PriceCharting when it turns up there', async () => {
    const weekAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    store.set('cards', 'recent', card({ pricing: { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', pair: { source: 'tcgplayer', id: null, checkedAt: weekAgo(3) } } }));
    const net = fakeNet();
    await updater(net.fetcher).updateCard('recent');
    expect(net.calls.some((u) => u.includes('tcgplayer'))).toBe(false);
    store.set('cards', 'tcgOnly', card({ pricing: { source: 'tcgplayer', id: '696683', linkedBy: 'user', pair: { source: 'pricecharting', id: null, checkedAt: weekAgo(8) } } }));
    expect(await updater(fakeNet().fetcher).updateCard('tcgOnly')).toBe('updated');
    expect(store.get('cards', 'tcgOnly')!.pricing).toMatchObject({ source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', linkedBy: 'auto', pair: { source: 'tcgplayer', id: '696683', linkedBy: 'user' } });
  });

  it('lets the person choose the other site’s product, stop using it, and keeps their choices when correcting a match', async () => {
    store.set('cards', 'c1', card());
    const net = fakeNet({ 'mp-search-api.tcgplayer.com/v1/search': () => Response.json(tcgSearch) });
    const u = updater(net.fetcher);
    await u.updateCard('c1');
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ source: 'pricecharting', pair: { source: 'tcgplayer', id: '696683', linkedBy: 'auto' } });
    // Correcting PriceCharting's product drops TCGplayer's automatic match, which is looked for again.
    const pc2 = { source: 'pricecharting' as const, id: '/game/pokemon-30th-celebration/lapras-131-promo', url: '', title: 'Lapras', set: 'Pokemon 30th Celebration' };
    net.calls.length = 0;
    await u.link('c1', pc2);
    expect(net.calls.filter((x) => x.includes('mp-search-api.tcgplayer.com/v1/search'))).toHaveLength(1);
    // Choosing TCGplayer's product makes it the pair; correcting PriceCharting's keeps it then.
    const tg = { source: 'tcgplayer' as const, id: '517045', url: 'https://www.tcgplayer.com/product/517045', title: 'Lapras', set: 'SV: Scarlet & Violet 151' };
    await u.link('c1', tg);
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ source: 'pricecharting', id: pc2.id, pair: { source: 'tcgplayer', id: '517045', linkedBy: 'user' } });
    await u.link('c1', { ...pc2, id: '/game/pokemon-30th-celebration/lapras-131' });
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ pair: { id: '517045', linkedBy: 'user' } });
    // Turned off: TCGplayer isn't asked, not even when the card is matched again.
    net.calls.length = 0;
    expect(await u.link('c1', { pair: 'off' })).toBe('updated');
    await u.link('c1', { source: 'auto' });
    expect(net.calls.some((x) => x.includes('tcgplayer'))).toBe(false);
    expect(store.get('cards', 'c1')).toMatchObject({ pricing: { source: 'pricecharting', pair: { source: 'tcgplayer', off: true } } });
    expect((store.get('cards', 'c1')!.prices as { quotes: object }[]).at(-1)).toMatchObject({ quotes: { pricecharting: 13.2 } });
    // Back on: searched again straight away.
    await u.link('c1', { pair: 'auto' });
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ pair: { source: 'tcgplayer', id: '696683', linkedBy: 'auto' } });
  });

  it("fills a card's details from its product during the update", async () => {
    store.set('cards', 'blank', card({ set: '', setCode: '' }));
    store.set('cards', 'auto', card());
    store.set('cards', 'wrong', card({ set: 'Some Other Set', released: '2001-01-01' }));
    const u = updater(fakeNet().fetcher);
    const pc = { source: 'pricecharting' as const, id: '/game/pokemon-30th-celebration/lapras-131', url: 'https://www.pricecharting.com/game/pokemon-30th-celebration/lapras-131', title: 'Lapras', set: 'Pokemon 30th Celebration' };
    await u.link('blank', pc);
    await u.updateCard('auto');
    await u.link('wrong', pc);
    expect(store.get('cards', 'blank')).toMatchObject({ set: 'Pokemon 30th Celebration', released: '2026-09-16' });
    expect(store.get('cards', 'auto')).toMatchObject({ set: '30th Celebration', released: '2026-09-16', pricing: { linkedBy: 'auto' } });
    expect(store.get('cards', 'wrong')).toMatchObject({ set: 'Pokemon 30th Celebration', released: '2001-01-01' });
    // TCGplayer's product details give the rarity too; without them the price still updates.
    store.set('cards', 'tcg', card({ set: '', rarity: '' }));
    const details = { productName: 'Lapras', setName: 'ME: 30th Celebration', rarityName: 'Illustration Rare', customAttributes: { releaseDate: '2026-09-16T00:00:00Z' } };
    const tg = { source: 'tcgplayer' as const, id: '696683', url: 'https://www.tcgplayer.com/product/696683', title: 'Lapras', set: 'ME: 30th Celebration' };
    await updater(fakeNet({ '/v1/product/696683/details': () => Response.json(details) }).fetcher).link('tcg', tg);
    expect(store.get('cards', 'tcg')).toMatchObject({ set: 'ME: 30th Celebration', rarity: 'Illustration Rare', released: '2026-09-16' });
    // A variant product fills in the card's variant; the plain one leaves it.
    store.set('cards', 'ball', card({ variant: '' }));
    store.set('cards', 'stamp', card({ variant: '30th stamp' }));
    await u.link('ball', { ...pc, id: '/game/pokemon-30th-celebration/lapras-ball-131', title: 'Lapras [Ball]' });
    await u.link('stamp', pc);
    expect(store.get('cards', 'ball')).toMatchObject({ variant: 'Ball', pricing: { title: 'Lapras [Ball]', linkedBy: 'user' } });
    expect(store.get('cards', 'stamp')).toMatchObject({ variant: '30th stamp' });
    store.set('cards', 'tcg2', card({ set: '' }));
    expect(await updater(fakeNet({ '/v1/product/696683/details': () => new Response('down', { status: 503 }) }).fetcher).link('tcg2', tg)).toBe('updated');
  });

  it('mends a link saved with "&amp;" in its address, and prices it', async () => {
    store.set('cards', 'sv', card({ pricing: { source: 'pricecharting', id: '/game/pokemon-scarlet-&amp;-violet-151/lapras-131', linkedBy: 'auto' } }));
    const net = fakeNet();
    expect(await updater(net.fetcher).updateCard('sv')).toBe('updated');
    expect(net.calls).toContain('https://www.pricecharting.com/game/pokemon-scarlet-&-violet-151/lapras-131');
    expect(net.calls.some((u) => u.includes('&amp;'))).toBe(false);
    expect(store.get('cards', 'sv')!.pricing).toMatchObject({ id: '/game/pokemon-scarlet-&-violet-151/lapras-131', url: 'https://www.pricecharting.com/game/pokemon-scarlet-&-violet-151/lapras-131', error: null });
  });

  it('matches a card again when its product address lands on the search page (renamed or merged)', async () => {
    const gone = '/game/pokemon-old-name/lapras-131';
    const searchPage = () => { const r = new Response('<html><table></table></html>', { headers: { 'Content-Type': 'text/html' } }); Object.defineProperty(r, 'url', { value: 'https://www.pricecharting.com/search-products?type=prices&q=lapras+131' }); return r; };
    for (const linkedBy of ['auto', 'user']) {
      store.set('cards', linkedBy, card({ pricing: { source: 'pricecharting', id: gone, linkedBy } }));
      expect(await updater(fakeNet({ [gone]: searchPage }).fetcher).updateCard(linkedBy)).toBe('updated');
      expect(store.get('cards', linkedBy)!.pricing).toMatchObject({ id: '/game/pokemon-30th-celebration/lapras-131', linkedBy: 'auto', error: null });
    }
    // Still gone and nothing certain found: the person chooses, and it isn't counted as a site failure.
    store.set('cards', 'odd', card({ name: 'Mystery', number: '999/1', pricing: { source: 'pricecharting', id: gone, linkedBy: 'user' } }));
    expect(await updater(fakeNet({ [gone]: searchPage }).fetcher).updateCard('odd')).toBe('needsMatch');
    expect(store.get('cards', 'odd')!.pricing).toMatchObject({ source: 'none', error: null });
  });

  it("prices from TCGplayer when PriceCharting refuses the binder's requests, and asks PriceCharting only once", async () => {
    const pcLapras = '/game/pokemon-30th-celebration/lapras-131';
    store.set('cards', 'both', card({ pricing: { source: 'pricecharting', id: pcLapras, linkedBy: 'auto', pair: { source: 'tcgplayer', id: '696683', linkedBy: 'auto' } } }));
    // Matched on PriceCharting only, and TCGplayer was searched 3 days ago: searched again at once.
    store.set('cards', 'pcOnly', card({ pricing: { source: 'pricecharting', id: pcLapras, linkedBy: 'auto', pair: { source: 'tcgplayer', id: null, checkedAt: '2026-09-30T15:00:00Z' } } }));
    store.set('cards', 'fresh', card());
    const net = fakeNet({ 'pricecharting.com': () => new Response('Forbidden', { status: 403 }), 'mp-search-api.tcgplayer.com/v1/search': () => Response.json(tcgSearch) });
    const s = await updater(net.fetcher).runAll('manual');
    expect(s.counts).toMatchObject({ updated: 3, failed: 0 });
    expect(s.errors).toEqual([]);
    expect(s.sitesOut).toEqual({ pricecharting: expect.stringMatching(/PriceCharting refused the binder's requests \(403\)/) });
    expect(net.calls.filter((u) => u.includes('pricecharting.com'))).toHaveLength(1);
    for (const id of ['both', 'pcOnly']) {
      expect(store.get('cards', id)).toMatchObject({ pricing: { source: 'pricecharting', id: pcLapras, error: null, pair: { source: 'tcgplayer', id: '696683' } }, prices: [expect.objectContaining({ where: 'TCGplayer', usd: 7.73, quotes: { tcgplayer: 7.73 } })] });
    }
    // A new card is matched on TCGplayer; PriceCharting is looked for again once it answers.
    expect(store.get('cards', 'fresh')).toMatchObject({ pricing: { source: 'tcgplayer', id: '696683', error: null }, prices: [expect.objectContaining({ where: 'TCGplayer' })] });
    expect(store.get('cards', 'fresh')!.pricing).not.toHaveProperty('pair.id');
    // The next update asks PriceCharting again; it answers, and becomes the new card's main product.
    const back = fakeNet({ 'mp-search-api.tcgplayer.com/v1/search': () => Response.json(tcgSearch) });
    now = new Date('2026-10-04T15:00:00Z');
    expect((await updater(back.fetcher).runAll('manual')).sitesOut).toBeUndefined();
    expect(store.get('cards', 'fresh')!.pricing).toMatchObject({ source: 'pricecharting', id: pcLapras, pair: { source: 'tcgplayer', id: '696683' } });
  });

  it('remembers a refusal for an hour outside the daily update, and says so when TCGplayer has no match', async () => {
    const pcLapras = '/game/pokemon-30th-celebration/lapras-131';
    store.set('cards', 'a', card({ pricing: { source: 'pricecharting', id: pcLapras, pair: { source: 'tcgplayer', id: null, checkedAt: '2026-10-02T15:00:00Z' } } }));
    store.set('cards', 'b', card({ pricing: { source: 'pricecharting', id: pcLapras, pair: { source: 'tcgplayer', id: null, checkedAt: '2026-10-02T15:00:00Z' } } }));
    const net = fakeNet({ 'pricecharting.com': () => new Response('Forbidden', { status: 403 }) });
    const u = updater(net.fetcher);
    expect(await u.updateCard('a')).toBe('failed');
    expect(store.get('cards', 'a')!.pricing).toMatchObject({ error: expect.stringMatching(/refused.*TCGplayer didn't find this card: choose its product with Change match/) });
    expect(await u.updateCard('b')).toBe('failed');
    expect(net.calls.filter((x) => x.includes('pricecharting.com'))).toHaveLength(1);
    expect(net.calls.filter((x) => x.includes('mp-search-api.tcgplayer.com/v1/search')).length).toBeGreaterThan(0);
    // The manual search leaves it out too.
    await u.search(card());
    expect(net.calls.filter((x) => x.includes('pricecharting.com'))).toHaveLength(1);
    now = new Date(now.getTime() + 61 * 60_000);
    await u.updateCard('b');
    expect(net.calls.filter((x) => x.includes('pricecharting.com'))).toHaveLength(2);
  });

  it('never asks PriceCharting while administrators have it turned off, and uses it again when turned back on', async () => {
    const config = new Config(dir);
    config.set({ pricing: { enabled: true, hour: 5, pricecharting: false } });
    const u = (f: Fetcher) => new PriceUpdater({ store, assets, fetcher: f, now: () => now, delayMs: 0, timeZone: 'America/Vancouver', config });
    store.set('cards', 'c1', card());
    store.set('cards', 'c2', card({ pricing: { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', pair: { source: 'tcgplayer', id: '696683' } } }));
    const net = fakeNet({ 'mp-search-api.tcgplayer.com/v1/search': () => Response.json(tcgSearch) });
    const s = await u(net.fetcher).runAll('manual');
    expect(s.counts).toMatchObject({ updated: 2, failed: 0 });
    expect(s.sitesOut).toEqual({ pricecharting: expect.stringMatching(/turned off/) });
    expect(net.calls.some((x) => x.includes('pricecharting.com'))).toBe(false);
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ source: 'tcgplayer', id: '696683' });
    expect(store.get('cards', 'c2')).toMatchObject({ pricing: { error: null }, prices: [expect.objectContaining({ where: 'TCGplayer' })] });
    expect((await u(net.fetcher).search(card())).every((c) => c.source === 'tcgplayer')).toBe(true);
    expect(net.calls.some((x) => x.includes('pricecharting.com'))).toBe(false);
    config.set({ pricing: { enabled: true, hour: 5, pricecharting: true } });
    expect(await u(fakeNet().fetcher).updateCard('c1')).toBe('updated');
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ source: 'pricecharting', pair: { source: 'tcgplayer', id: '696683' } });
  });

  it('runs once a day after the set hour, catching up after downtime', () => {
    const u = new PriceUpdater({ store, assets, fetcher: fakeNet().fetcher, now: () => now, hour: 5, timeZone: 'America/Vancouver' });
    expect(u.today(new Date('2026-10-03T06:30:00Z'))).toBe('2026-10-02'); // still the 2nd in Vancouver
    expect(u.today(new Date('2026-10-03T15:00:00Z'))).toBe('2026-10-03');
  });
});

describe('the card databases (TCGdex and pokemontcg.io)', () => {
  const td = JSON.parse(fixture('tcgdex-card.json')) as TcgdexCard;
  const ptcg = (JSON.parse(fixture('ptcg-card.json')) as { data: PtcgCard }).data;
  const found = (JSON.parse(fixture('ptcg-search.json')) as { data: PtcgCard[] }).data;

  it('reads the printing from the variant, and keeps commons and uncommons to their own printing', () => {
    expect(printingOf('Reverse Holo', 'Uncommon')).toEqual({ kind: 'reverse', first: false, strict: false });
    expect(printingOf('Holo', 'Rare Holo')).toEqual({ kind: 'holo', first: false, strict: false });
    expect(printingOf('1st Edition Holo', 'Rare')).toEqual({ kind: 'holo', first: true, strict: false });
    expect(printingOf('', 'Common')).toEqual({ kind: 'normal', first: false, strict: true });
  });

  it("reads TCGplayer's market price and product, and Cardmarket's trend, for the printing", () => {
    expect(tcgdexTcgplayer(td, printingOf('', 'Uncommon'))).toEqual({ usd: 0.24, productId: '516694' });
    expect(tcgdexTcgplayer(td, printingOf('Reverse Holo', 'Uncommon'))).toEqual({ usd: 2.12, productId: '516694' });
    expect(tcgdexCardmarket(td, printingOf('', 'Uncommon'))).toBe(0.09);
    expect(tcgdexCardmarket(td, printingOf('Reverse Holo', 'Uncommon'))).toBe(3.07);
    // A holo-only rare: its holo price is the card's; a common never borrows it.
    const holoOnly = { ...td, pricing: { tcgplayer: { holofoil: { productId: 1, marketPrice: 9.5 } }, cardmarket: null } };
    expect(tcgdexTcgplayer(holoOnly, printingOf('', 'Rare Holo'))).toEqual({ usd: 9.5, productId: '1' });
    expect(tcgdexTcgplayer(holoOnly, printingOf('', 'Common'))).toBeNull();
    expect(ptcgTcgplayer(ptcg, printingOf('Reverse Holo', 'Uncommon'))).toBe(2.14);
  });

  it('finds the same card on pokemontcg.io by set and number', () => {
    expect(choosePtcg(found, td)?.id).toBe('sv3pt5-131');
    expect(choosePtcg(found, { ...td, set: { id: 'me02.5', name: '30th Celebration', cardCount: { official: 128 } } })?.id).toBe('me55-131');
    expect(choosePtcg(found, { ...td, localId: '132' })).toBeNull();
  });
});

describe('prices and pictures from the card databases', () => {
  let dir: string;
  let store: Store;
  let assets: Assets;
  let now: Date;
  const HIRES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('pokemontcg.io large picture')]);
  const lapras = (over: Record<string, unknown> = {}) => ({ name: 'Lapras', set: '151', number: '131/165', rarity: 'Uncommon', variant: 'Reverse Holo', status: 'binder', prices: [], details: { source: 'tcgdex', result: 'complete', id: 'sv03.5-131', checkedAt: '2026-10-01T00:00:00Z' }, ...over });
  const rates = { observations: [{ d: '2026-10-09', FXUSDCAD: { v: '1.4271' }, FXEURCAD: { v: '1.5978' } }] };
  const dbNet = (over: Record<string, () => Response> = {}) =>
    fakeNet({
      'api.tcgdex.net/v2/en/cards/sv03.5-131': () => Response.json(JSON.parse(fixture('tcgdex-card.json'))),
      'api.pokemontcg.io/v2/cards?q=': () => Response.json(JSON.parse(fixture('ptcg-search.json'))),
      'api.pokemontcg.io/v2/cards/sv3pt5-131': () => Response.json(JSON.parse(fixture('ptcg-card.json'))),
      '131_hires.png': () => new Response(new Uint8Array(HIRES), { headers: { 'Content-Type': 'image/png' } }),
      'bankofcanada.ca': () => Response.json(rates),
      ...over,
    });
  const updater = (net: ReturnType<typeof fakeNet>, config?: Config) =>
    new PriceUpdater({ store, assets, fetcher: net.fetcher, now: () => now, delayMs: 0, timeZone: 'America/Vancouver', config, catalog: new Catalog({ fetcher: net.fetcher, now: () => now }) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-catalog-'));
    store = new Store(dir);
    assets = new Assets(dir);
    now = new Date('2026-10-10T15:00:00Z');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("logs the highest of TCGplayer and Cardmarket without scraping TCGplayer, with pokemontcg.io's large picture", async () => {
    store.set('cards', 'c1', lapras());
    // PriceCharting refusing, as it does now.
    const net = dbNet({ 'pricecharting.com': () => new Response('Forbidden', { status: 403 }) });
    const s = await updater(net).runAll('manual');
    expect(s.counts).toMatchObject({ updated: 1, failed: 0 });
    const c = store.get('cards', 'c1')!;
    // Matched to the TCGplayer product TCGdex names, without searching TCGplayer.
    expect(c.pricing).toMatchObject({ source: 'tcgplayer', id: '516694', linkedBy: 'auto', error: null, catalog: { tcgdexId: 'sv03.5-131', ptcgId: 'sv3pt5-131' } });
    expect(net.calls.some((u) => u.includes('tcgplayer.com'))).toBe(false);
    // Reverse holo: TCGplayer US$2.12, Cardmarket €3.07 = US$3.44 at the day's rates; Cardmarket is higher.
    expect(c.prices).toEqual([
      expect.objectContaining({ where: 'Cardmarket', usd: 3.44, amount: 4.91, quotes: { tcgplayer: 2.12, cardmarket: 3.44 }, note: 'Daily update · higher of TCGplayer US$2.12 and Cardmarket €3.07 (US$3.44) at 1.4271 (€1 = C$1.5978)' }),
    ]);
    expect(c.pricing).toMatchObject({ imageUrl: 'https://images.pokemontcg.io/sv3pt5/131_hires.png' });
    expect(fs.readFileSync(assets.find(c.officialImageId as string)!.file)).toEqual(HIRES);
    expect(store.get('settings', 'main')).toMatchObject({ usdToCad: 1.4271, eurToCad: 1.5978 });
    // The next day pokemontcg.io's card is read by its id, not searched for again.
    now = new Date('2026-10-11T15:00:00Z');
    const next = dbNet({ 'pricecharting.com': () => new Response('Forbidden', { status: 403 }) });
    await updater(next).runAll('manual');
    expect(next.calls.filter((u) => u.includes('api.pokemontcg.io/v2/cards?q='))).toHaveLength(0);
    expect(next.calls.filter((u) => u.includes('api.pokemontcg.io/v2/cards/sv3pt5-131'))).toHaveLength(1);
  });

  it('compares PriceCharting too when it answers, keeping a PriceCharting picture the card already has', async () => {
    const pcLink = { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', linkedBy: 'auto' };
    store.set('cards', 'fresh', lapras({ pricing: pcLink }));
    // Outside a daily update, the rates saved by the last one are used.
    store.set('settings', 'main', { usdToCad: 1.4271, eurToCad: 1.5978 });
    const net = dbNet();
    expect(await updater(net).updateCard('fresh')).toBe('updated');
    const fresh = store.get('cards', 'fresh')!;
    expect(fresh.pricing).toMatchObject({ source: 'pricecharting', pair: { source: 'tcgplayer', id: '516694', linkedBy: 'auto' }, imageUrl: 'https://images.pokemontcg.io/sv3pt5/131_hires.png' });
    expect((fresh.prices as { where: string; quotes: object; note: string }[])[0]).toMatchObject({
      where: 'PriceCharting',
      quotes: { pricecharting: 13.2, tcgplayer: 2.12, cardmarket: 3.44 },
      note: expect.stringMatching(/^Daily update · highest of PriceCharting US\$13\.20, TCGplayer US\$2\.12 and Cardmarket €3\.07 \(US\$3\.44\)/),
    });
    expect(net.calls.some((u) => u.endsWith('/1600.jpg'))).toBe(false);
    // A card with a PriceCharting picture keeps it.
    const pcPicture = assets.put(JPEG)!;
    const pcUrl = parsePriceChartingProduct(fixture('pricecharting-product.html'), pcLink.id).image;
    store.set('cards', 'old', lapras({ pricing: { ...pcLink, imageUrl: pcUrl }, officialImageId: pcPicture.id }));
    const again = dbNet();
    expect(await updater(again).updateCard('old')).toBe('updated');
    expect(again.calls.some((u) => u.includes('131_hires.png'))).toBe(false);
    expect(store.get('cards', 'old')!.officialImageId).toBe(pcPicture.id);
  });

  it('leaves Cardmarket out when administrators turn it off', async () => {
    const config = new Config(dir);
    config.set({ pricing: { enabled: true, hour: 5, pricecharting: false, cardmarket: false } });
    store.set('cards', 'c1', lapras());
    const net = dbNet();
    await updater(net, config).runAll('manual');
    expect(store.get('cards', 'c1')!.prices).toEqual([expect.objectContaining({ where: 'TCGplayer', usd: 2.12, quotes: { tcgplayer: 2.12 }, note: 'Daily update · US$2.12 at 1.4271' })]);
    expect(net.calls.some((u) => u.includes('pricecharting.com'))).toBe(false);
  });

  it('prices a card the databases know even when it has no product on either site', async () => {
    store.set('cards', 'c1', lapras({ variant: '', rarity: 'Common' }));
    // TCGdex has no TCGplayer price for it (so no product either); pokemontcg.io does.
    const noTcg = () => {
      const card = JSON.parse(fixture('tcgdex-card.json'));
      delete card.pricing.tcgplayer;
      return Response.json(card);
    };
    const ptcgFound = () => Response.json({ data: [JSON.parse(fixture('ptcg-card.json')).data] });
    const net = dbNet({ 'api.tcgdex.net/v2/en/cards/sv03.5-131': noTcg, 'api.pokemontcg.io/v2/cards?q=': ptcgFound, 'pricecharting.com': () => new Response('Forbidden', { status: 403 }) });
    expect(await updater(net).updateCard('c1')).toBe('updated');
    const c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'none' });
    // pokemontcg.io's regular price US$0.23; no Cardmarket price without a saved euro rate (the daily update saves one).
    expect((c.prices as { where: string; usd: number }[])[0]).toMatchObject({ where: 'TCGplayer', usd: 0.23 });
  });

  it("carries on without the databases when they don't answer", async () => {
    store.set('cards', 'c1', lapras({ pricing: { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', linkedBy: 'auto', pair: { source: 'tcgplayer', id: null, checkedAt: '2026-10-09T00:00:00Z' } } }));
    const net = dbNet({ 'api.tcgdex.net/v2/en/cards/sv03.5-131': () => new Response('down', { status: 500 }) });
    expect(await updater(net).updateCard('c1')).toBe('updated');
    expect(store.get('cards', 'c1')!.prices).toEqual([expect.objectContaining({ where: 'PriceCharting', quotes: { pricecharting: 13.2 } })]);
  });
});

describe('pricing over HTTP', () => {
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
    await request(app).post('/api/pricing/link/c1').send({ pair: 'off' }).expect(400); // not matched on either site
    store.set('cards', 'c2', { name: 'Lapras', number: '131/128', status: 'binder', prices: [], pricing: { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131' } });
    const off = await request(app).post('/api/pricing/link/c2').send({ pair: 'off' }).expect(200);
    expect(off.body).toMatchObject({ outcome: 'updated', card: { pricing: { pair: { source: 'tcgplayer', off: true } } } });
    await request(app).post('/api/pricing/link/nope').send({ source: 'off' }).expect(404);
    await request(app).post('/api/pricing/run').expect(202);
    await request(createApp({ store, assets })).post('/api/pricing/run').expect(503);
  });

  it('lets administrators turn PriceCharting off and on, keeping the choice when only the schedule changes', async () => {
    const config = new Config(dir);
    const updater = new PriceUpdater({ store, assets, fetcher: fakeNet().fetcher, delayMs: 0, config });
    const app = createApp({ store, assets, updater, config });
    expect((await request(app).get('/api/admin/pricing').expect(200)).body.schedule).toMatchObject({ pricecharting: true });
    expect((await request(app).put('/api/admin/pricing').send({ enabled: true, hour: 5, pricecharting: false }).expect(200)).body.schedule).toMatchObject({ pricecharting: false });
    expect((await request(app).put('/api/admin/pricing').send({ enabled: true, hour: 7 }).expect(200)).body.schedule).toMatchObject({ hour: 7, pricecharting: false });
    expect(new Config(dir).get().pricing).toEqual({ enabled: true, hour: 7, pricecharting: false, cardmarket: true });
    expect(updater.siteOut('pricecharting')).toMatch(/turned off/);
    await request(app).put('/api/admin/pricing').send({ enabled: true, hour: 7, pricecharting: 'no' }).expect(400);
  });

});
