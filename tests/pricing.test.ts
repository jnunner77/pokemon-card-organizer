import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { makeBackup } from '../server/backup';
import { Config } from '../server/config';
import { Catalog, choosePtcg, chooseVariant, printingOf, ptcgDetails, ptcgTcgplayer, variantPrices, tcgdexCardmarket, tcgdexTcgplayer, type PtcgCard, type TcgdexCard } from '../server/pricing/catalog';
import { chooseMatch, detailsFromProduct, searchQuery, variantFromProduct } from '../server/pricing/match';
import { PriceCharting, gradedPrice, oldAddress, parseProduct } from '../server/pricing/pricecharting';
import { type Candidate, type Fetcher, retryPolicy, releaseDate } from '../server/pricing/sources';
import { PriceUpdater, pricesDisagree, thinAutoPrices } from '../server/pricing/updater';
import { Secret } from '../server/secrets';
import { Logger } from '../server/log';
import { Store } from '../server/store';

retryPolicy.baseMs = 1; // retries happen at once in tests

const fixture = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a card image')]);
const PC_SEARCH = JSON.parse(fixture('pricecharting-api-search.json')) as { products: Record<string, unknown>[] };
/** 30th Celebration Lapras: ungraded US$13.20, with graded prices. */
const PC_PRODUCT = JSON.parse(fixture('pricecharting-api-product.json')) as Record<string, unknown>;
const LAPRAS_30TH = '14330011';
const boc = (v: string, d = '2026-10-02') => ({ observations: [{ d, FXUSDCAD: { v } }] });

/**
 * A stand-in for the internet: answers each URL the price code asks for and records the calls.
 * PriceCharting's API is asked by POST with the token in the body; its calls are recorded as
 * ".../api/products?q=Lapras 131" or ".../api/product?id=14330011", and the tokens sent in `tokens`.
 */
function fakeNet(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const tokens: (string | null)[] = [];
  const urls: string[] = [];
  const fetcher: Fetcher = async (input, init) => {
    let url = String(input);
    urls.push(url);
    if (url.startsWith('https://www.pricecharting.com/api/')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      tokens.push(body.get('t'));
      url = `${url}?${body.has('q') ? `q=${body.get('q')}` : `id=${body.get('id')}`}`;
    }
    calls.push(url);
    for (const [k, fn] of Object.entries(overrides)) if (url.includes(k)) return fn();
    if (url.includes('bankofcanada.ca')) return Response.json(boc('1.4246'));
    if (/pricecharting\.com\/api\/products\?q=lapras/i.test(url)) return Response.json(PC_SEARCH);
    if (url.includes('pricecharting.com/api/products')) return Response.json({ status: 'success', products: [] });
    if (url.includes('pricecharting.com/api/product?id=')) {
      const id = url.split('id=')[1];
      const p = [PC_PRODUCT, ...PC_SEARCH.products].find((x) => x.id === id);
      return p ? Response.json({ ...p, status: 'success' }) : Response.json({ status: 'error', 'error-message': 'No such product' }, { status: 404 });
    }
    if (url.endsWith('_in_1000x1000.jpg')) return new Response(new Uint8Array(JPEG), { headers: { 'Content-Type': 'image/jpeg' } });
    return new Response('not found', { status: 404 });
  };
  return { fetcher, calls, tokens, urls };
}
type Net = ReturnType<typeof fakeNet>;
const pcCalls = (net: Net) => net.calls.filter((u) => u.includes('pricecharting.com'));
/** PriceCharting's API with a token (or none), asking the fake internet, without waiting a second between calls. */
const pcApi = (net: Net, token: string | null = 'test-token') => new PriceCharting({ token: () => token, fetcher: net.fetcher, gapMs: 0 });
const refusedToken = () => Response.json({ status: 'error', error: 'Unknown access token', 'error-message': 'Unknown access token' }, { status: 403 });

describe("reading PriceCharting's API", () => {
  it('reads products: name, number and variant, set, and prices from pennies', () => {
    const [p] = PC_SEARCH.products.map(parseProduct);
    expect(p).toMatchObject({ source: 'pricecharting', id: LAPRAS_30TH, url: 'https://www.pricecharting.com/game/14330011', title: 'Lapras', number: '131', set: 'Pokemon 30th Celebration', usd: 13.2, thumb: null, grades: {} });
    expect(parseProduct(PC_SEARCH.products[2])).toMatchObject({ title: 'Lapras [Reverse Holo]', set: 'Pokemon Scarlet & Violet 151', usd: 2.23 });
    expect(parseProduct(PC_SEARCH.products[4]).usd).toBeNull(); // no price
    expect(() => parseProduct({ 'product-name': 'Lapras #131' })).toThrow(/without an id/);
    const full = parseProduct(PC_PRODUCT);
    expect(full).toMatchObject({ released: '2026-09-16', grades: { 'Grade 7': 21, 'Grade 8': 26, 'Grade 9': 45, 'Grade 9.5': 60, 'PSA 10': 120, 'BGS 10': 150, 'CGC 10': 90, 'CGC 10 Pristine': 300 } });
    expect([releaseDate('December 1, 2023'), releaseDate('May 9, 1999'), releaseDate('Smarch 1, 2020'), releaseDate('')]).toEqual(['2023-12-01', '1999-05-09', null, null]);
  });

  it("prices a graded card at its grade, or the nearest grade PriceCharting has", () => {
    const { grades } = parseProduct(PC_PRODUCT);
    const g = (grader: string, grade: string, list = grades) => gradedPrice(list, grader, grade);
    expect(g('PSA', '10')).toEqual({ label: 'PSA 10', usd: 120, exact: true });
    expect(g('BGS', '10')).toEqual({ label: 'BGS 10', usd: 150, exact: true });
    expect(g('CGC', '10')).toEqual({ label: 'CGC 10', usd: 90, exact: true });
    expect(g('CGC', 'Pristine 10')).toEqual({ label: 'CGC 10 Pristine', usd: 300, exact: true });
    expect(g('PSA', '9.5')).toMatchObject({ label: 'Grade 9.5', exact: true });
    expect(g('CGC', '9')).toMatchObject({ label: 'Grade 9', usd: 45 });
    expect(g('PSA', '8.5')).toMatchObject({ label: 'Grade 8', usd: 26, exact: true });
    expect(g('BGS', '7.5')).toMatchObject({ label: 'Grade 7', usd: 21, exact: true });
    // No price for it: the nearest grade, a 10 by another grader before a 9.5 (PSA's first), the lower of two as near.
    expect(g('TAG', '10')).toEqual({ label: 'PSA 10', usd: 120, exact: false });
    expect(g('PSA', '6')).toEqual({ label: 'Grade 7', usd: 21, exact: false });
    expect(g('PSA', '8.5', { 'Grade 8': 26, 'Grade 9': 45 })).toMatchObject({ label: 'Grade 8' });
    expect(g('PSA', '8.5', { 'Grade 9': 45 })).toMatchObject({ label: 'Grade 9', exact: false });
    expect(g('CGC', '10', { 'Grade 9.5': 60, 'CGC 10 Pristine': 300 })).toEqual({ label: 'Grade 9.5', usd: 60, exact: false }); // never a Pristine 10's price
    // Not graded, or no graded prices (as with a subscription that has none): none.
    expect(g('Raw', '10')).toBeNull();
    expect(g('PSA', '')).toBeNull();
    expect(g('PSA', '10', {})).toBeNull();
  });

  it('reads the product addresses saved when its pages were read, to find them in the API', () => {
    const a = oldAddress('/game/pokemon-scarlet-&amp;-violet-151/lapras-reverse-holo-131')!;
    expect(a.query).toBe('lapras reverse holo 131 pokemon scarlet & violet 151');
    const list = PC_SEARCH.products.map(parseProduct);
    expect(list.filter(a.is).map((p) => p.id)).toEqual(['5809712']);
    expect(list.filter(oldAddress('/game/pokemon-30th-celebration/lapras-131')!.is).map((p) => p.id)).toEqual([LAPRAS_30TH]);
    expect(oldAddress('14330011')).toBeNull();
  });

  it('sends the token in the request body, one call at a time, at most one a second', async () => {
    const net = fakeNet();
    const pc = new PriceCharting({ token: () => 'secret-token', fetcher: net.fetcher, gapMs: 300 });
    const started = Date.now();
    const [found, one] = await Promise.all([pc.search('Lapras 131'), pc.product(LAPRAS_30TH)]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(found.map((p) => p.id)).toEqual(['14330011', '3453448', '5809712', '5809512', '8709155']);
    expect(one).toMatchObject({ id: LAPRAS_30TH, usd: 13.2, grades: { 'PSA 10': 120 } });
    expect(net.tokens).toEqual(['secret-token', 'secret-token']);
    expect(net.urls.every((u) => !u.includes('secret-token') && !u.includes('?'))).toBe(true);
    // A token PriceCharting doesn't know, a product it doesn't have, and no token at all.
    await expect(new PriceCharting({ token: () => 'bad', fetcher: fakeNet({ 'pricecharting.com': refusedToken }).fetcher, gapMs: 0 }).search('x')).rejects.toThrow(/didn't accept the API token/);
    await expect(pc.product('999')).rejects.toThrow(/no product 999/);
    await expect(new PriceCharting({ token: () => null, fetcher: net.fetcher }).search('x')).rejects.toThrow(/no API token/);
  });
});

describe('matching a card to a product', () => {
  const pc = PC_SEARCH.products.map(parseProduct);
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

describe('the daily update with PriceCharting', () => {
  let dir: string;
  let store: Store;
  let assets: Assets;
  let now: Date;
  const card = (over: Record<string, unknown> = {}) => ({ name: 'Lapras', set: '30th Celebration', setCode: '30C', number: '131/128', status: 'binder', prices: [], binderId: 'b1', page: 1, slot: 1, ...over });
  const updater = (net: Net, o: { token?: string | null; config?: Config } = {}) =>
    new PriceUpdater({ store, assets, fetcher: net.fetcher, now: () => now, delayMs: 0, timeZone: 'America/Vancouver', pricecharting: pcApi(net, o.token === undefined ? 'test-token' : o.token), config: o.config });
  const linked = (over: Record<string, unknown> = {}) => card({ pricing: { source: 'pricecharting', id: LAPRAS_30TH, linkedBy: 'auto' }, ...over });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-price-'));
    store = new Store(dir);
    assets = new Assets(dir);
    now = new Date('2026-10-03T15:00:00Z');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('links the card to its PriceCharting product and logs today’s ungraded price in CAD', async () => {
    store.set('cards', 'c1', card());
    const net = fakeNet();
    const summary = await updater(net).runAll('manual');
    expect(summary.counts.updated).toBe(1);
    expect(summary.rate).toBe(1.4246);
    const c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'pricecharting', id: LAPRAS_30TH, url: 'https://www.pricecharting.com/game/14330011', title: 'Lapras', linkedBy: 'auto', error: null });
    expect(c.prices).toEqual([expect.objectContaining({ type: 'market', currency: 'CAD', amount: 18.8, usd: 13.2, auto: true, date: '2026-10-03', where: 'PriceCharting', quotes: { pricecharting: 13.2 } })]);
    // One search, then the product's prices. PriceCharting's API has no pictures (the card databases give them).
    expect(pcCalls(net)).toEqual(['https://www.pricecharting.com/api/products?q=Lapras 131', 'https://www.pricecharting.com/api/product?id=14330011']);
    expect(c.officialImageId).toBeUndefined();
    expect(store.get('settings', 'main')).toMatchObject({ usdToCad: 1.4246 });
    expect(store.get('settings', 'pricing')).toMatchObject({ running: false, lastRun: { date: '2026-10-03', counts: { updated: 1 } } });
  });

  it('keeps one automatic price a day for 30 days, one a week before that, and never touches the person’s own entries', async () => {
    const old = (date: string, amount: number) => ({ id: date, type: 'market', amount, currency: 'CAD', date, auto: true });
    store.set('cards', 'c1', linked({
      // 2026-08-24 to 08-30 is one week (Monday to Sunday): only its last entry stays
      prices: [old('2026-08-01', 10), old('2026-08-24', 10.5), old('2026-08-27', 10.7), old('2026-09-02', 11), old('2026-09-03', 12), old('2026-10-03', 13), { id: 'paid', type: 'paid', amount: 5, currency: 'CAD', date: '2025-01-01' }, { id: 'mine', type: 'market', amount: 30, currency: 'CAD', date: '2026-01-01' }],
    }));
    await updater(fakeNet()).runAll('manual');
    await updater(fakeNet()).runAll('manual'); // a second run the same day replaces today's entry
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
    const s = await updater(fakeNet()).runAll('manual');
    expect(s.counts).toMatchObject({ skipped: 1, off: 1, needsMatch: 1, updated: 0 });
    expect(store.get('cards', 'sold')!.prices).toEqual([]);
    expect(store.get('cards', 'odd')!.pricing).toMatchObject({ source: 'none' });
  });

  it('records a failure and carries on with the next card', async () => {
    store.set('cards', 'a', card({ pricing: { source: 'pricecharting', id: '777' } }));
    store.set('cards', 'b', card());
    const net = fakeNet({ 'product?id=777': () => new Response('down', { status: 500 }), 'bankofcanada.ca': () => new Response('down', { status: 400 }) });
    store.set('settings', 'main', { usdToCad: 1.4 });
    const s = await updater(net).runAll('manual');
    expect(s.counts).toMatchObject({ failed: 1, updated: 1 });
    expect(s.rate).toBe(1.4); // the saved rate when the Bank of Canada is unreachable
    expect(s.errors[0].error).toMatch(/500/);
    expect(store.get('cards', 'a')!.pricing).toMatchObject({ error: expect.stringMatching(/500/) });
  });

  it("prices a graded card at PriceCharting's price for its grade, and says when there is none", async () => {
    store.set('cards', 'psa10', linked({ grader: 'PSA', grade: '10' }));
    store.set('cards', 'tag9', linked({ grader: 'TAG', grade: '9.5', condition: 'Damaged' }));
    store.set('cards', 'none', card({ grader: 'CGC', grade: '9', pricing: { source: 'pricecharting', id: '5809512', linkedBy: 'user' } }));
    const u = updater(fakeNet());
    for (const id of ['psa10', 'tag9', 'none']) expect(await u.updateCard(id)).toBe('updated');
    expect((store.get('cards', 'psa10')!.prices as object[])[0]).toMatchObject({ where: 'PriceCharting', usd: 120, amount: 164.4, grade: 'PSA 10', quotes: { pricecharting: 120 }, note: "Daily update · PriceCharting's PSA 10 price US$120.00 at 1.3700" });
    expect((store.get('cards', 'tag9')!.prices as object[])[0]).toMatchObject({ usd: 60, grade: 'Grade 9.5' });
    // PriceCharting has no graded price for this one (as when the subscription has none): its ungraded price, saying so.
    const none = (store.get('cards', 'none')!.prices as { grade?: string; usd: number; note: string }[])[0];
    expect(none).toMatchObject({ usd: 1.01, note: expect.stringMatching(/no graded price on PriceCharting, so the ungraded price$/) });
    expect(none.grade).toBeUndefined();
  });

  it('looks for the PriceCharting product again only after a week, and makes it the main product when it turns up', async () => {
    const weekAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    store.set('cards', 'recent', card({ pricing: { source: 'tcgplayer', id: '696683', linkedBy: 'user', pair: { source: 'pricecharting', id: null, checkedAt: weekAgo(3) } } }));
    const net = fakeNet();
    await updater(net).updateCard('recent');
    expect(pcCalls(net)).toEqual([]);
    store.set('cards', 'tcgOnly', card({ pricing: { source: 'tcgplayer', id: '696683', linkedBy: 'user', pair: { source: 'pricecharting', id: null, checkedAt: weekAgo(8) } } }));
    expect(await updater(fakeNet()).updateCard('tcgOnly')).toBe('updated');
    expect(store.get('cards', 'tcgOnly')!.pricing).toMatchObject({ source: 'pricecharting', id: LAPRAS_30TH, linkedBy: 'auto', pair: { source: 'tcgplayer', id: '696683', linkedBy: 'user' } });
  });

  it("fills a card's details from its product during the update", async () => {
    store.set('cards', 'blank', card({ set: '', setCode: '' }));
    store.set('cards', 'auto', card());
    store.set('cards', 'wrong', card({ set: 'Some Other Set', released: '2001-01-01' }));
    const u = updater(fakeNet());
    const pc = { source: 'pricecharting' as const, id: LAPRAS_30TH, url: 'https://www.pricecharting.com/game/14330011', title: 'Lapras', set: 'Pokemon 30th Celebration' };
    await u.link('blank', pc);
    await u.updateCard('auto');
    await u.link('wrong', pc);
    expect(store.get('cards', 'blank')).toMatchObject({ set: 'Pokemon 30th Celebration', released: '2026-09-16' });
    expect(store.get('cards', 'auto')).toMatchObject({ set: '30th Celebration', released: '2026-09-16', pricing: { linkedBy: 'auto' } });
    expect(store.get('cards', 'wrong')).toMatchObject({ set: 'Pokemon 30th Celebration', released: '2001-01-01' });
    // A variant product fills in the card's variant; the plain one leaves it.
    store.set('cards', 'rev', card({ set: '151', variant: '' }));
    store.set('cards', 'stamp', card({ variant: '30th stamp' }));
    await u.link('rev', { source: 'pricecharting', id: '5809712', url: '', title: 'Lapras [Reverse Holo]', set: 'Pokemon Scarlet & Violet 151' });
    await u.link('stamp', pc);
    expect(store.get('cards', 'rev')).toMatchObject({ variant: 'Reverse Holo', pricing: { title: 'Lapras [Reverse Holo]', linkedBy: 'user' }, prices: [expect.objectContaining({ usd: 2.23 })] });
    expect(store.get('cards', 'stamp')).toMatchObject({ variant: '30th stamp' });
  });

  it('moves links saved by page address (before the API) to their API products', async () => {
    store.set('cards', 'sv', card({ set: '151', pricing: { source: 'pricecharting', id: '/game/pokemon-scarlet-&amp;-violet-151/lapras-131', linkedBy: 'user' } }));
    store.set('cards', 'pair', card({ pricing: { source: 'tcgplayer', id: '696683', linkedBy: 'user', pair: { source: 'pricecharting', id: '/game/pokemon-30th-celebration/lapras-131', linkedBy: 'auto' } } }));
    const net = fakeNet();
    const u = updater(net);
    expect(await u.updateCard('sv')).toBe('updated');
    expect(store.get('cards', 'sv')).toMatchObject({ pricing: { source: 'pricecharting', id: '5809512', url: 'https://www.pricecharting.com/game/5809512', linkedBy: 'user', error: null }, prices: [expect.objectContaining({ usd: 1.01 })] });
    expect(pcCalls(net)).toEqual(['https://www.pricecharting.com/api/products?q=lapras 131 pokemon scarlet & violet 151', 'https://www.pricecharting.com/api/product?id=5809512']);
    await u.updateCard('pair');
    expect(store.get('cards', 'pair')!.pricing).toMatchObject({ source: 'tcgplayer', pair: { source: 'pricecharting', id: LAPRAS_30TH } });
    // An address the API doesn't have: matched again (here, to a product it finds for the card).
    store.set('cards', 'gone', card({ pricing: { source: 'pricecharting', id: '/game/pokemon-old-name/lapras-131', linkedBy: 'user' } }));
    expect(await u.updateCard('gone')).toBe('updated');
    expect(store.get('cards', 'gone')!.pricing).toMatchObject({ id: LAPRAS_30TH, linkedBy: 'auto' });
  });

  it("matches a card again when PriceCharting no longer has its product", async () => {
    for (const linkedBy of ['auto', 'user']) {
      store.set('cards', linkedBy, card({ pricing: { source: 'pricecharting', id: '424242', linkedBy } }));
      expect(await updater(fakeNet()).updateCard(linkedBy)).toBe('updated');
      expect(store.get('cards', linkedBy)!.pricing).toMatchObject({ id: LAPRAS_30TH, linkedBy: 'auto', error: null });
    }
    // Still gone and nothing certain found: the person chooses, and it isn't counted as a site failure.
    store.set('cards', 'odd', card({ name: 'Mystery', number: '999/1', pricing: { source: 'pricecharting', id: '424242', linkedBy: 'user' } }));
    expect(await updater(fakeNet()).updateCard('odd')).toBe('needsMatch');
    expect(store.get('cards', 'odd')!.pricing).toMatchObject({ source: 'none', error: null });
  });

  it("stops asking PriceCharting for the rest of an update when it refuses the token", async () => {
    store.set('cards', 'a', linked());
    store.set('cards', 'b', linked());
    store.set('cards', 'c', card());
    const net = fakeNet({ 'pricecharting.com': refusedToken });
    const s = await updater(net).runAll('manual');
    expect(pcCalls(net)).toHaveLength(1);
    expect(s.counts).toMatchObject({ failed: 3 });
    expect(s.sitesOut).toEqual({ pricecharting: expect.stringMatching(/^PriceCharting didn't accept the API token: check it under Administration → Prices\./) });
    expect(store.get('cards', 'b')!.pricing).toMatchObject({ error: expect.stringMatching(/didn't accept the API token/) });
  });

  it('never asks PriceCharting without its token', async () => {
    store.set('cards', 'a', linked());
    store.set('cards', 'b', card());
    const net = fakeNet();
    const u = updater(net, { token: null });
    const s = await u.runAll('manual');
    expect(pcCalls(net)).toEqual([]);
    expect(s.sitesOut).toBeUndefined();
    expect(s.counts).toMatchObject({ failed: 1, needsMatch: 1 });
    expect(store.get('cards', 'a')!.pricing).toMatchObject({ error: "PriceCharting isn't set up: add its API token under Administration → Prices." });
    expect(u.schedule().pricecharting).toBe(false);
    expect(await u.search(card())).toEqual([]);
    expect(pcCalls(net)).toEqual([]);
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

  it("reads pokemontcg.io's details in the binder's words", () => {
    expect(ptcgDetails(ptcg)).toEqual({ set: '151', setCode: null, rarity: 'Uncommon', artist: 'LINNE', released: '2023-09-22' });
    expect(ptcgDetails({ ...ptcg, rarity: 'Rare Ultra', set: { ...ptcg.set, ptcgoCode: 'MEW' } })).toMatchObject({ setCode: 'MEW', rarity: 'Ultra Rare' });
  });

  it("reads the card's own variant: patterns, stamps, 1st Edition and Shadowless", () => {
    const ex = JSON.parse(fixture('tcgdex-exeggcute.json')) as TcgdexCard;
    const cz = JSON.parse(fixture('tcgdex-charizard.json')) as TcgdexCard;
    const pk = JSON.parse(fixture('tcgdex-pikachu.json')) as TcgdexCard;
    const pick = (c: TcgdexCard, text: string) => {
      const r = chooseVariant(c, text);
      return r.unknown ? 'unknown' : [r.variant!.type, r.variant!.foil, ...(r.variant!.stamp ?? []), r.variant!.subtype].filter(Boolean).join(' ');
    };
    expect(pick(ex, '')).toBe('normal');
    expect(pick(ex, 'Reverse Holo')).toBe('reverse');
    expect(pick(ex, 'Poke Ball')).toBe('reverse pokeball');
    expect(pick(ex, 'Poké Ball Reverse Holo')).toBe('reverse pokeball');
    expect(pick(ex, 'Ball')).toBe('reverse pokeball');
    expect(pick(ex, 'Master Ball')).toBe('reverse masterball');
    expect(pick(ex, 'Holo')).toBe('unknown'); // no plain holo Exeggcute: not priced as another printing
    expect(pick(ex, 'Great Ball')).toBe('unknown');
    expect(pick(cz, '')).toBe('holo unlimited');
    expect(pick(cz, 'Holo')).toBe('holo unlimited');
    expect(pick(cz, 'Shadowless')).toBe('holo shadowless');
    expect(pick(cz, '1st Edition')).toBe('holo 1st-edition shadowless');
    expect(pick(cz, '1st Edition Shadowless Holo')).toBe('holo 1st-edition shadowless');
    expect(pick(pk, 'Pokemon Together Stamp')).toBe('normal pokemon-together');
    expect(pick(pk, 'Cosmo Holo')).toBe('reverse cosmos');
    expect(pick(pk, 'Staff Stamp')).toBe('unknown');
    expect(pick(pk, 'Stamped')).toBe('unknown');
    // Words describing the card itself don't make it another printing.
    expect(pick(pk, 'Full Art')).toBe('normal');
    expect(pick(cz, 'Holo Rare')).toBe('holo unlimited');

    const price = (c: TcgdexCard, text: string) => variantPrices(chooseVariant(c, text).variant!);
    expect(price(ex, 'Master Ball')).toEqual({ tcgplayer: { usd: 1.27, productId: '610637' }, cardmarketEur: 1.61 });
    expect(price(ex, 'Poke Ball')).toEqual({ tcgplayer: { usd: 0.34, productId: '610536' }, cardmarketEur: 0.35 });
    expect(price(ex, '')).toEqual({ tcgplayer: { usd: 0.05, productId: '610356' }, cardmarketEur: 0.02 });
    expect(price(cz, '')).toEqual({ tcgplayer: { usd: 928.32, productId: '42382' }, cardmarketEur: 432.4 });
    // No TCGplayer price for a 1st Edition Shadowless Charizard: never the unlimited one's.
    expect(price(cz, '1st Edition Shadowless')).toEqual({ tcgplayer: null, cardmarketEur: 3330.71 });
    expect(price(pk, 'Pokemon Together Stamp')).toEqual({ tcgplayer: null, cardmarketEur: 57.24 });
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
  /** With PriceCharting's token unless `token` is null (a binder without a subscription). */
  const updater = (net: Net, config?: Config, token: string | null = 'test-token') =>
    new PriceUpdater({ store, assets, fetcher: net.fetcher, now: () => now, delayMs: 0, timeZone: 'America/Vancouver', config, catalog: new Catalog({ fetcher: net.fetcher, now: () => now }), pricecharting: pcApi(net, token) });
  const noPc = (net: Net, config?: Config) => updater(net, config, null);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-catalog-'));
    store = new Store(dir);
    assets = new Assets(dir);
    now = new Date('2026-10-10T15:00:00Z');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('takes no prices from a TCGdex match in another set than the card is filed under, until the person confirms it', async () => {
    // Filed under "151", but TCGdex's match is flagged as another set's card (Cards to check).
    const flagged = { source: 'tcgdex', result: 'complete', id: 'sv03.5-131', checkedAt: '2026-10-01T00:00:00Z', filedUnder: { as: '151', id: 'other', name: 'Another set' } };
    store.set('cards', 'c', lapras({ details: flagged }));
    const net = dbNet();
    expect(await noPc(net).updateCard('c')).not.toBe('updated');
    expect(net.calls.some((u) => u.includes('api.tcgdex.net/v2/en/cards/sv03.5-131'))).toBe(false);
    expect(store.get('cards', 'c')!.prices).toEqual([]);
    // Ignored in Cards to check (the person says it's right): priced again.
    store.update('cards', 'c', { checksIgnored: 'lapras|131/165' });
    expect(await noPc(net).updateCard('c')).toBe('updated');
    // Chosen by the person, or filed under its set since: priced too.
    store.set('cards', 'd', lapras({ details: { ...flagged, chosen: true } }));
    store.set('cards', 'e', lapras({ set: 'Scarlet & Violet 151', details: flagged }));
    expect(await noPc(net).updateCard('d')).toBe('updated');
    expect(await noPc(net).updateCard('e')).toBe('updated');
  });

  it('calls prices disagreeing when one is over 3 times another and US$5 apart', () => {
    expect(pricesDisagree({ pricecharting: 4, tcgplayer: 310 })).toBe(true);
    expect(pricesDisagree({ pricecharting: 10, tcgplayer: 29 })).toBe(false); // under 3×
    expect(pricesDisagree({ pricecharting: 0.1, tcgplayer: 0.9 })).toBe(false); // 9×, but cents apart
    expect(pricesDisagree({ pricecharting: 2, tcgplayer: 7.5 })).toBe(true);
    expect(pricesDisagree({ pricecharting: 300 })).toBe(false);
  });

  it('logs pokemontcg.io failing once per update, not once per card, and still prices every card', async () => {
    for (let i = 1; i <= 5; i++) store.set('cards', `c${i}`, lapras());
    // pokemontcg.io answering 500 to everything, as it often does (quickly, at random).
    const down = () => new Response('', { status: 500 });
    const net = dbNet({ 'api.pokemontcg.io/v2/cards?q=': down, 'api.pokemontcg.io/v2/cards/sv3pt5-131': down });
    const log = new Logger({ stdout: false });
    const u = new PriceUpdater({ store, assets, fetcher: net.fetcher, now: () => now, delayMs: 0, timeZone: 'America/Vancouver', catalog: new Catalog({ fetcher: net.fetcher, now: () => now }), log });
    const s = await u.runAll('manual');
    expect(s.counts.updated).toBe(5);
    // Tried 3 times for each of 3 cards, then left alone for the rest of the update.
    expect(net.calls.filter((c) => c.includes('pokemontcg.io'))).toHaveLength(3 * 3);
    const warnings = log.query({ level: 'warn', cat: 'pricing' }).map((e) => e.msg);
    expect(warnings).toEqual(["pokemontcg.io failed for 5 of the 5 cards it was asked about (api.pokemontcg.io answered 500); after failing 3 times in a row it wasn't asked about the rest. It only adds large pictures and blank details, so prices aren't affected; those cards are tried again in the next update."]);
    expect(log.query({ level: 'info', cat: 'pricing', text: 'pokemontcg.io:' })).toHaveLength(5);
    // The next update starts counting again; nothing to say when it works.
    const ok = new Logger({ stdout: false });
    await new PriceUpdater({ store, assets, fetcher: dbNet().fetcher, now: () => now, delayMs: 0, timeZone: 'America/Vancouver', catalog: new Catalog({ fetcher: dbNet().fetcher, now: () => now }), log: ok }).runAll('manual');
    expect(ok.query({ level: 'warn', cat: 'pricing', text: 'pokemontcg.io' })).toHaveLength(0);
    // A card priced on its own (just added) still warns straight away.
    const one = new Logger({ stdout: false });
    store.set('cards', 'new', lapras({ officialImageId: null }));
    await new PriceUpdater({ store, assets, fetcher: net.fetcher, now: () => now, delayMs: 0, timeZone: 'America/Vancouver', catalog: new Catalog({ fetcher: net.fetcher, now: () => now }), log: one }).updateCard('new');
    expect(one.query({ level: 'warn', cat: 'pricing' }).map((e) => e.msg)).toEqual([expect.stringMatching(/^Lapras 151 131\/165: pokemontcg\.io: api\.pokemontcg\.io answered 500$/)]);
  });

  it("logs the highest of TCGplayer and Cardmarket without reading TCGplayer, with pokemontcg.io's large picture", async () => {
    store.set('cards', 'c1', lapras());
    // Without PriceCharting's token.
    const net = dbNet();
    const s = await noPc(net).runAll('manual');
    expect(s.counts).toMatchObject({ updated: 1, failed: 0 });
    const c = store.get('cards', 'c1')!;
    // Matched to the TCGplayer product TCGdex names, without searching TCGplayer.
    expect(c.pricing).toMatchObject({ source: 'tcgplayer', id: '516694', linkedBy: 'auto', error: null, catalog: { tcgdexId: 'sv03.5-131', ptcgId: 'sv3pt5-131' } });
    expect(net.calls.some((u) => u.includes('tcgplayer.com') || u.includes('pricecharting.com'))).toBe(false);
    // Reverse holo: TCGplayer US$2.12, Cardmarket €3.07 = US$3.44 at the day's rates; Cardmarket is higher.
    expect(c.prices).toEqual([
      expect.objectContaining({ where: 'Cardmarket', usd: 3.44, amount: 4.91, quotes: { tcgplayer: 2.12, cardmarket: 3.44 }, note: 'Daily update · higher of TCGplayer US$2.12 and Cardmarket €3.07 (US$3.44) at 1.4271 (€1 = C$1.5978)' }),
    ]);
    expect(c.pricing).toMatchObject({ imageUrl: 'https://images.pokemontcg.io/sv3pt5/131_hires.png' });
    expect(fs.readFileSync(assets.find(c.officialImageId as string)!.file)).toEqual(HIRES);
    expect(store.get('settings', 'main')).toMatchObject({ usdToCad: 1.4271, eurToCad: 1.5978 });
    // The next day pokemontcg.io isn't asked at all: the card has its picture.
    now = new Date('2026-10-11T15:00:00Z');
    const next = dbNet();
    await noPc(next).runAll('manual');
    expect(next.calls.filter((u) => u.includes('pokemontcg.io'))).toHaveLength(0);
    expect(store.get('cards', 'c1')!.prices).toHaveLength(2);
    // A week on, a card with blanks left (151 has no set code there) is read again, by its id.
    now = new Date('2026-10-18T15:00:00Z');
    const week = dbNet();
    await noPc(week).runAll('manual');
    expect(week.calls.filter((u) => u.includes('api.pokemontcg.io/v2/cards?q='))).toHaveLength(0);
    expect(week.calls.filter((u) => u.includes('api.pokemontcg.io/v2/cards/sv3pt5-131'))).toHaveLength(1);
  });

  it('compares PriceCharting too, keeping a PriceCharting picture the card already has', async () => {
    const pcLink = { source: 'pricecharting', id: LAPRAS_30TH, linkedBy: 'auto' };
    store.set('cards', 'fresh', lapras({ pricing: pcLink }));
    // Outside a daily update, the rates saved by the last one are used.
    store.set('settings', 'main', { usdToCad: 1.4271, eurToCad: 1.5978 });
    const net = dbNet();
    expect(await updater(net).updateCard('fresh')).toBe('updated');
    const fresh = store.get('cards', 'fresh')!;
    expect(fresh.pricing).toMatchObject({ source: 'pricecharting', pair: { source: 'tcgplayer', id: '516694', linkedBy: 'auto' }, imageUrl: 'https://images.pokemontcg.io/sv3pt5/131_hires.png' });
    // This card (151's Lapras) is linked to the 30th Celebration Lapras on PriceCharting: its US$13.20
    // is far from the others' US$2.12 and US$3.44, so the card is flagged and the main product's price used.
    expect((fresh.prices as { where: string; quotes: object; note: string }[])[0]).toMatchObject({
      where: 'PriceCharting',
      quotes: { pricecharting: 13.2, tcgplayer: 2.12, cardmarket: 3.44 },
      note: expect.stringMatching(/^Daily update · PriceCharting's US\$13\.20: the sources disagree \(PriceCharting US\$13\.20, TCGplayer US\$2\.12, Cardmarket €3\.07 \(US\$3\.44\)\), so the highest wasn't used/),
    });
    expect(fresh.pricing).toMatchObject({ disagree: { quotes: { pricecharting: 13.2, tcgplayer: 2.12, cardmarket: 3.44 }, sig: `pricecharting:${LAPRAS_30TH}|tcgplayer:516694|sv03.5-131` } });
    // The person says the prices are right: the highest is used, until the matches change.
    store.update('cards', 'fresh', { pricesDisagreeIgnored: `pricecharting:${LAPRAS_30TH}|tcgplayer:516694|sv03.5-131` });
    await updater(net).updateCard('fresh');
    expect(store.get('cards', 'fresh')!.pricing).toMatchObject({ disagree: null });
    expect((store.get('cards', 'fresh')!.prices as { note: string }[]).at(-1)!.note).toMatch(/^Daily update · highest of PriceCharting US\$13\.20, TCGplayer US\$2\.12 and Cardmarket €3\.07 \(US\$3\.44\)/);
    // A card with a picture from PriceCharting's pages (before the API) keeps it.
    const pcPicture = assets.put(JPEG)!;
    const pcUrl = 'https://storage.googleapis.com/images.pricecharting.com/asqso2to674mken7/1600.jpg';
    store.set('cards', 'old', lapras({ pricing: { ...pcLink, imageUrl: pcUrl }, officialImageId: pcPicture.id }));
    const again = dbNet();
    expect(await updater(again).updateCard('old')).toBe('updated');
    expect(again.calls.some((u) => u.includes('131_hires.png'))).toBe(false);
    expect(store.get('cards', 'old')!.officialImageId).toBe(pcPicture.id);
  });

  it('leaves Cardmarket out when administrators turn it off', async () => {
    const config = new Config(dir);
    config.set({ pricing: { enabled: true, hour: 5, cardmarket: false } });
    store.set('cards', 'c1', lapras());
    const net = dbNet();
    await noPc(net, config).runAll('manual');
    expect(store.get('cards', 'c1')!.prices).toEqual([expect.objectContaining({ where: 'TCGplayer', usd: 2.12, quotes: { tcgplayer: 2.12 }, note: 'Daily update · US$2.12 at 1.4271' })]);
    expect(net.calls.some((u) => u.includes('pricecharting.com'))).toBe(false);
  });

  it('prices a card the databases know even when it has no product on either site', async () => {
    store.set('cards', 'c1', lapras({ variant: '', rarity: 'Common' }));
    // TCGdex has no TCGplayer price for it (so no product either); pokemontcg.io does.
    const noTcg = () => {
      const card = JSON.parse(fixture('tcgdex-card.json'));
      delete card.pricing.tcgplayer;
      for (const v of card.variants_detailed) delete v.pricing.tcgplayer;
      return Response.json(card);
    };
    const ptcgFound = () => Response.json({ data: [JSON.parse(fixture('ptcg-card.json')).data] });
    const net = dbNet({ 'api.tcgdex.net/v2/en/cards/sv03.5-131': noTcg, 'api.pokemontcg.io/v2/cards?q=': ptcgFound });
    expect(await noPc(net).updateCard('c1')).toBe('updated');
    const c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'none' });
    // pokemontcg.io's regular price US$0.23; no Cardmarket price without a saved euro rate (the daily update saves one).
    expect((c.prices as { where: string; usd: number }[])[0]).toMatchObject({ where: 'TCGplayer', usd: 0.23 });
  });

  it('fills what TCGdex left blank from pokemontcg.io, never what the person typed', async () => {
    const known = { catalog: { tcgdexId: 'sv03.5-131', ptcgId: 'sv3pt5-131' } };
    store.set('cards', 'blank', lapras({ set: '151', rarity: '', artist: '', released: '', setCode: '', pricing: { source: 'none', ...known } }));
    store.set('cards', 'typed', lapras({ rarity: 'Rare', artist: 'Someone', pricing: { source: 'none', ...known } }));
    const net = dbNet();
    await noPc(net).runAll('manual');
    // 151 has no set code on pokemontcg.io, so that stays blank.
    expect(store.get('cards', 'blank')).toMatchObject({ set: '151', rarity: 'Uncommon', artist: 'LINNE', released: '2023-09-22', setCode: '' });
    expect(store.get('cards', 'typed')).toMatchObject({ rarity: 'Rare', artist: 'Someone' });
    expect(net.calls.filter((u) => u.includes('api.pokemontcg.io/v2/cards?q='))).toHaveLength(0);
  });

  it("prices and links a Master Ball card from its own variant, undoing a match to the regular card's product", async () => {
    const tcgdex = (id: string, f: string) => ({ [`api.tcgdex.net/v2/en/cards/${id}`]: () => Response.json(JSON.parse(fixture(f))) });
    const exeggcute = { name: 'Exeggcute', set: 'Prismatic Evolutions', number: '001/131', rarity: 'Common', status: 'binder', prices: [], details: { source: 'tcgdex', result: 'complete', id: 'sv08.5-001', checkedAt: '2026-10-01T00:00:00Z' } };
    // As the update left it before variants were read: linked to the regular card's TCGplayer product.
    store.set('cards', 'mb', { ...exeggcute, variant: 'Master Ball', pricing: { source: 'tcgplayer', id: '610356', linkedBy: 'auto' } });
    store.set('cards', 'chosen', { ...exeggcute, variant: 'Master Ball', pricing: { source: 'tcgplayer', id: '610356', linkedBy: 'user' } });
    const net = dbNet(tcgdex('sv08.5-001', 'tcgdex-exeggcute.json'));
    await noPc(net).runAll('manual');
    const mb = store.get('cards', 'mb')!;
    expect(mb.pricing).toMatchObject({ source: 'tcgplayer', id: '610637', linkedBy: 'auto', imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/610637_in_1000x1000.jpg' });
    // TCGplayer US$1.27 vs Cardmarket €1.61 = US$1.80.
    expect(mb.prices).toEqual([expect.objectContaining({ where: 'Cardmarket', quotes: { tcgplayer: 1.27, cardmarket: 1.8 }, note: expect.stringMatching(/^Daily update \(Master Ball reverse\) · higher of TCGplayer US\$1\.27 and Cardmarket €1\.61/) })]);
    // The product the person chose stays; TCGdex doesn't price it (TCGplayer's pages aren't read), so Cardmarket does, and the card says why.
    expect(store.get('cards', 'chosen')).toMatchObject({ pricing: { source: 'tcgplayer', id: '610356', linkedBy: 'user', error: expect.stringMatching(/doesn't price this TCGplayer product/) }, prices: [expect.objectContaining({ where: 'Cardmarket', quotes: { cardmarket: 1.8 } })] });
  });

  it("never gives a 1st Edition or unlisted variant another printing's price, and pictures it from TCGdex when there's nothing larger", async () => {
    const charizard = { name: 'Charizard', set: 'Base Set', number: '4/102', rarity: 'Rare', status: 'binder', prices: [], details: { source: 'tcgdex', result: 'complete', id: 'base1-4', checkedAt: '2026-10-01T00:00:00Z' } };
    const pikachu = { name: 'Pikachu', set: '151', number: '025/165', rarity: 'Common', status: 'binder', prices: [], details: { source: 'tcgdex', result: 'complete', id: 'sv03.5-025', checkedAt: '2026-10-01T00:00:00Z' } };
    store.set('cards', 'first', { ...charizard, variant: '1st Edition Shadowless' });
    store.set('cards', 'staff', { ...pikachu, variant: 'Staff Stamp' });
    const TCGDEX_PIC = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('tcgdex picture')]);
    const net = dbNet({
      'api.tcgdex.net/v2/en/cards/base1-4': () => Response.json(JSON.parse(fixture('tcgdex-charizard.json'))),
      'api.tcgdex.net/v2/en/cards/sv03.5-025': () => Response.json(JSON.parse(fixture('tcgdex-pikachu.json'))),
      'assets.tcgdex.net/en/base/base1/4/high.png': () => new Response(new Uint8Array(TCGDEX_PIC)),
    });
    const s = await noPc(net).runAll('manual');
    // Cardmarket's 1st Edition Shadowless price only (€3,330.71), not the US$928 unlimited card.
    const first = store.get('cards', 'first')!;
    expect(first.prices).toEqual([expect.objectContaining({ where: 'Cardmarket', quotes: { cardmarket: 3729.11 } })]);
    expect(first.pricing).toMatchObject({ source: 'none', imageUrl: 'https://assets.tcgdex.net/en/base/base1/4/high.png' });
    expect(fs.readFileSync(assets.find(first.officialImageId as string)!.file)).toEqual(TCGDEX_PIC);
    // A stamp TCGdex doesn't list: no database price at all; left to a match on PriceCharting.
    expect(store.get('cards', 'staff')).toMatchObject({ prices: [], pricing: { source: 'none' } });
    expect(s.counts).toMatchObject({ updated: 1, needsMatch: 1 });
  });

  it("carries on without the databases when they don't answer", async () => {
    store.set('cards', 'c1', lapras({ pricing: { source: 'pricecharting', id: LAPRAS_30TH, linkedBy: 'auto', pair: { source: 'tcgplayer', id: null, checkedAt: '2026-10-09T00:00:00Z' } } }));
    const net = dbNet({ 'api.tcgdex.net/v2/en/cards/sv03.5-131': () => new Response('down', { status: 500 }) });
    expect(await updater(net).updateCard('c1')).toBe('updated');
    expect(store.get('cards', 'c1')!.prices).toEqual([expect.objectContaining({ where: 'PriceCharting', quotes: { pricecharting: 13.2 } })]);
  });
  it("matches on TCGplayer through the card databases when PriceCharting doesn't list the card, and makes PriceCharting's product the main one once chosen", async () => {
    store.set('cards', 'c1', lapras({ name: 'Lapras', number: '131/165', variant: '' }));
    const net = dbNet({ 'api/products?q=': () => Response.json({ status: 'success', products: [] }) });
    const u = updater(net);
    expect(await u.updateCard('c1')).toBe('updated');
    let c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'tcgplayer', id: '516694', linkedBy: 'auto', pair: { source: 'pricecharting', id: null } });
    expect((c.prices as { where: string; quotes: object }[]).at(-1)).toMatchObject({ quotes: { tcgplayer: 0.24 } });
    // The person chooses its PriceCharting product: the main product now; TCGplayer's stays as its pair.
    expect(await u.link('c1', { source: 'pricecharting', id: '5809512', url: 'https://www.pricecharting.com/game/5809512', title: 'Lapras', set: 'Pokemon Scarlet & Violet 151' })).toBe('updated');
    c = store.get('cards', 'c1')!;
    expect(c.pricing).toMatchObject({ source: 'pricecharting', id: '5809512', linkedBy: 'user', pair: { source: 'tcgplayer', id: '516694', linkedBy: 'auto' } });
    expect((c.prices as { where: string; quotes: object }[]).at(-1)).toMatchObject({ where: 'PriceCharting', quotes: { pricecharting: 1.01, tcgplayer: 0.24 } });
  });

  it('uses the sources that answered when PriceCharting fails or has no price', async () => {
    const both = () => lapras({ variant: '', pricing: { source: 'pricecharting', id: LAPRAS_30TH, linkedBy: 'auto', pair: { source: 'tcgplayer', id: '516694', linkedBy: 'auto' } } });
    store.set('cards', 'pcDown', both());
    expect(await updater(dbNet({ 'product?id=': () => new Response('down', { status: 503 }) })).updateCard('pcDown')).toBe('updated');
    expect(store.get('cards', 'pcDown')).toMatchObject({ pricing: { error: expect.stringMatching(/503/), pair: { error: null } }, prices: [expect.objectContaining({ where: 'TCGplayer', usd: 0.24, quotes: { tcgplayer: 0.24 } })] });
    store.set('cards', 'pcNoPrice', both());
    expect(await updater(dbNet({ 'product?id=': () => Response.json({ status: 'success', id: LAPRAS_30TH, 'product-name': 'Lapras #131', 'console-name': 'Pokemon 30th Celebration' }) })).updateCard('pcNoPrice')).toBe('updated');
    expect(store.get('cards', 'pcNoPrice')).toMatchObject({ pricing: { error: null }, prices: [expect.objectContaining({ where: 'TCGplayer', quotes: { tcgplayer: 0.24 } })] });
    // PriceCharting and the card databases both down: a failure.
    store.set('cards', 'allDown', both());
    expect(await updater(dbNet({ 'product?id=': () => new Response('down', { status: 503 }), 'api.tcgdex.net/v2/en/cards/sv03.5-131': () => new Response('down', { status: 503 }) })).updateCard('allDown')).toBe('failed');
    expect(store.get('cards', 'allDown')).toMatchObject({ prices: [], pricing: { error: expect.stringMatching(/PriceCharting answered 503/) } });
  });

  it("lets the person choose or stop using the card's TCGplayer product, keeping their choices when correcting a match", async () => {
    store.set('cards', 'c1', lapras({ variant: '', pricing: { source: 'pricecharting', id: LAPRAS_30TH, linkedBy: 'auto' } }));
    const net = dbNet();
    const u = updater(net);
    await u.updateCard('c1');
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ pair: { source: 'tcgplayer', id: '516694', linkedBy: 'auto' } });
    // A TCGplayer product TCGdex doesn't name can be chosen, but has no price (TCGplayer's pages aren't read).
    await u.link('c1', { source: 'tcgplayer', id: '517045', url: 'https://www.tcgplayer.com/product/517045', title: 'Lapras', set: 'SV: Scarlet & Violet 151' });
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ source: 'pricecharting', pair: { id: '517045', linkedBy: 'user', error: expect.stringMatching(/doesn't price this TCGplayer product/) } });
    // Correcting PriceCharting's product keeps the person's TCGplayer choice.
    await u.link('c1', { source: 'pricecharting', id: '5809512', url: '', title: 'Lapras', set: 'Pokemon Scarlet & Violet 151' });
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ id: '5809512', pair: { id: '517045', linkedBy: 'user' } });
    // Turned off: TCGplayer's price isn't used, not even when the card is matched again.
    expect(await u.link('c1', { pair: 'off' })).toBe('updated');
    await u.link('c1', { source: 'auto' });
    expect(store.get('cards', 'c1')).toMatchObject({ pricing: { source: 'pricecharting', pair: { source: 'tcgplayer', off: true } } });
    expect((store.get('cards', 'c1')!.prices as { quotes: Record<string, number> }[]).at(-1)!.quotes.tcgplayer).toBeUndefined();
    // Back on: the product TCGdex names, straight away.
    await u.link('c1', { pair: 'auto' });
    expect(store.get('cards', 'c1')!.pricing).toMatchObject({ pair: { source: 'tcgplayer', id: '516694', linkedBy: 'auto' } });
  });

  it("values a graded card at PriceCharting's price for its grade only", async () => {
    store.set('cards', 'g', lapras({ grader: 'PSA', grade: '10', pricing: { source: 'pricecharting', id: LAPRAS_30TH, linkedBy: 'auto' } }));
    store.set('settings', 'main', { usdToCad: 1.4271, eurToCad: 1.5978 });
    await updater(dbNet()).updateCard('g');
    // Not TCGplayer's or Cardmarket's (raw card) prices, though they're known.
    expect((store.get('cards', 'g')!.prices as object[])[0]).toMatchObject({ where: 'PriceCharting', usd: 120, grade: 'PSA 10', quotes: { pricecharting: 120 } });
  });

  it('purges everything that came from PriceCharting, and forgets its token', async () => {
    const pcPicture = assets.put(JPEG)!;
    const day = (date: string, where: string, usd: number, quotes: Record<string, number>, over: object = {}) => ({ id: date + where, type: 'market', currency: 'CAD', date, auto: true, where, usd, amount: Math.round(usd * 140) / 100, quotes, ...over });
    store.set('cards', 'pc', lapras({
      officialImageId: pcPicture.id,
      pricing: { source: 'pricecharting', id: LAPRAS_30TH, linkedBy: 'user', imageUrl: 'https://storage.googleapis.com/images.pricecharting.com/x/1600.jpg', pair: { source: 'tcgplayer', id: '516694', linkedBy: 'auto' } },
      prices: [
        day('2026-10-08', 'PriceCharting', 13.2, { pricecharting: 13.2, tcgplayer: 2.12, cardmarket: 3.44 }),
        day('2026-10-09', 'TCGplayer', 20, { pricecharting: 13.2, tcgplayer: 20 }, { note: 'Daily update · higher of PriceCharting US$13.20 and TCGplayer US$20.00 at 1.4000' }),
        day('2026-10-07', 'PriceCharting', 13.2, { pricecharting: 13.2 }),
        day('2026-10-06', 'PriceCharting', 120, { pricecharting: 120 }, { grade: 'PSA 10' }),
        { id: 'mine', type: 'market', amount: 15, currency: 'CAD', date: '2026-10-01', where: 'PriceCharting' },
      ],
    }));
    store.set('cards', 'only', lapras({ pricing: { source: 'pricecharting', id: '5809512', linkedBy: 'auto', pair: { source: 'tcgplayer', id: null, checkedAt: '2026-10-01T00:00:00Z' } } }));
    store.set('cards', 'none', lapras({ pricing: { source: 'none', candidates: [{ source: 'pricecharting', id: '1' }, { source: 'tcgplayer', id: '2' }] } }));
    store.set('cards', 'tcg', lapras({ pricing: { source: 'tcgplayer', id: '516694', pair: { source: 'pricecharting', id: null, checkedAt: '2026-10-01T00:00:00Z' } }, prices: [day('2026-10-09', 'TCGplayer', 2, { tcgplayer: 2 })] }));
    const before = JSON.stringify(store.get('cards', 'tcg')!.prices);
    let forgotten = false;
    const out = updater(dbNet()).purgePriceCharting(() => (forgotten = true));
    expect(forgotten).toBe(true);
    expect(out).toEqual({ cards: 4, prices: 4, removed: 2, pictures: 1 });
    const pc = store.get('cards', 'pc')!;
    // Its TCGplayer product is the main one now; the picture is gone (the next update downloads another).
    expect(pc.pricing).toMatchObject({ source: 'tcgplayer', id: '516694', pair: null, imageUrl: null });
    expect(pc.officialImageId).toBeNull();
    expect(assets.find(pcPicture.id)).toBeNull();
    // Entries PriceCharting set are re-priced from the day's other sources at the same rate, or removed; the person's own stays.
    expect(pc.prices).toEqual([
      expect.objectContaining({ date: '2026-10-08', where: 'Cardmarket', usd: 3.44, amount: 4.82, quotes: { tcgplayer: 2.12, cardmarket: 3.44 }, note: "Daily update · Cardmarket US$3.44 (PriceCharting's price removed)" }),
      expect.objectContaining({ date: '2026-10-09', where: 'TCGplayer', usd: 20, quotes: { tcgplayer: 20 }, note: "Daily update · TCGplayer US$20.00 (PriceCharting's price removed)" }),
      expect.objectContaining({ id: 'mine', where: 'PriceCharting' }),
    ]);
    expect(store.get('cards', 'only')!.pricing).toMatchObject({ source: 'none', id: null, title: null, pair: { source: 'tcgplayer', id: null } });
    expect(store.get('cards', 'none')!.pricing).toMatchObject({ candidates: [{ source: 'tcgplayer', id: '2' }] });
    expect(store.get('cards', 'tcg')!.pricing).toMatchObject({ source: 'tcgplayer', pair: null });
    expect(JSON.stringify(store.get('cards', 'tcg')!.prices)).toBe(before);
    // Nothing PriceCharting gave is left in what was changed, apart from the person's own entry.
    expect(JSON.stringify({ ...pc, prices: (pc.prices as { id: string }[]).filter((e) => e.id !== 'mine') })).not.toMatch(/13\.2|PriceCharting US/);
  });
});

describe('pricing over HTTP', () => {
  let dir: string;
  let secrets: string;
  let store: Store;
  let assets: Assets;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-api-'));
    secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-secrets-'));
    store = new Store(dir);
    assets = new Assets(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(secrets, { recursive: true, force: true });
  });
  /** The app as index.ts puts it together: PriceCharting's token in its own secret file. */
  const setup = (net: Net, o: { token?: string } = {}) => {
    const token = new Secret(secrets, 'pricecharting-token');
    if (o.token) token.write(o.token);
    const api = new PriceCharting({ token: () => token.read(), fetcher: net.fetcher, gapMs: 0 });
    const config = new Config(dir);
    const updater = new PriceUpdater({ store, assets, fetcher: net.fetcher, delayMs: 0, config, pricecharting: api });
    return { token, updater, app: createApp({ store, assets, updater, config, pricecharting: { token, api } }) };
  };

  it("searches PriceCharting and links a chosen product", async () => {
    const { app } = setup(fakeNet(), { token: 'a'.repeat(40) });
    store.set('cards', 'c1', { name: 'Lapras', set: '30th Celebration', number: '131/128', status: 'binder', prices: [] });
    const s = await request(app).get('/api/pricing/search?card=c1').expect(200);
    expect(s.body.candidates[0]).toMatchObject({ source: 'pricecharting', id: LAPRAS_30TH, title: 'Lapras', usd: 13.2 });
    expect(s.body.candidates.every((c: Candidate) => c.source === 'pricecharting')).toBe(true);
    const l = await request(app).post('/api/pricing/link/c1').send({ source: 'off' }).expect(200);
    expect(l.body).toMatchObject({ outcome: 'off', card: { pricing: { source: 'off' } } });
    await request(app).post('/api/pricing/link/c1').send({ source: 'ebay', id: 'x' }).expect(400);
    await request(app).post('/api/pricing/link/c1').send({ pair: 'off' }).expect(400); // not matched on either site
    store.set('cards', 'c2', { name: 'Lapras', number: '131/128', status: 'binder', prices: [], pricing: { source: 'pricecharting', id: LAPRAS_30TH } });
    const off = await request(app).post('/api/pricing/link/c2').send({ pair: 'off' }).expect(200);
    expect(off.body).toMatchObject({ outcome: 'updated', card: { pricing: { pair: { source: 'tcgplayer', off: true } } } });
    await request(app).post('/api/pricing/link/nope').send({ source: 'off' }).expect(404);
    await request(app).post('/api/pricing/run').expect(202);
    await request(createApp({ store, assets })).post('/api/pricing/run').expect(503);
  });

  it("keeps PriceCharting's token in its own file, checked with PriceCharting first, and never shows it", async () => {
    const good = '0123456789abcdef0123456789abcdef01234567';
    const net = fakeNet({ 'products?q=charizard': () => (net.tokens.at(-1) === good ? Response.json({ status: 'success', products: [] }) : refusedToken()) });
    const { app, token, updater } = setup(net);
    expect((await request(app).get('/api/admin/pricing').expect(200)).body).toMatchObject({ schedule: { pricecharting: false }, pricecharting: { set: false, savedAt: null } });
    await request(app).put('/api/admin/pricing/pricecharting-token').send({ token: 'not a token!' }).expect(400);
    const bad = await request(app).put('/api/admin/pricing/pricecharting-token').send({ token: 'f'.repeat(40) }).expect(400);
    expect(bad.body.error).toMatch(/didn't accept that token/);
    expect(token.info().set).toBe(false);
    const saved = await request(app).put('/api/admin/pricing/pricecharting-token').send({ token: ` ${good} ` }).expect(200);
    expect(saved.body).toEqual({ pricecharting: { set: true, savedAt: expect.any(String) } });
    expect(token.read()).toBe(good);
    expect(fs.statSync(path.join(secrets, 'pricecharting-token')).mode & 0o777).toBe(0o600);
    const status = await request(app).get('/api/admin/pricing').expect(200);
    expect(status.body).toMatchObject({ schedule: { pricecharting: true }, pricecharting: { set: true } });
    expect(JSON.stringify(status.body)).not.toContain(good);
    // The page is told PriceCharting is set up; the token is nowhere in the ledger or its backup.
    expect(store.get('settings', 'pricing')).toMatchObject({ pricecharting: true });
    expect(JSON.stringify(makeBackup(store, assets))).not.toContain(good);
    const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
    expect(files.some((f) => fs.readFileSync(path.join(f.parentPath, f.name), 'utf8').includes(good))).toBe(false);
    expect(updater.schedule().pricecharting).toBe(true);
    await request(app).delete('/api/admin/pricing/pricecharting-token').expect(200);
    expect(token.info().set).toBe(false);
    expect(store.get('settings', 'pricing')).toMatchObject({ pricecharting: false });
  });

  it('purges PriceCharting from the ledger and removes the token in one action', async () => {
    const { app, token } = setup(fakeNet(), { token: 'b'.repeat(40) });
    store.set('cards', 'c1', { name: 'Lapras', status: 'binder', pricing: { source: 'pricecharting', id: LAPRAS_30TH }, prices: [{ id: 'p', type: 'market', amount: 18.8, currency: 'CAD', date: '2026-10-01', auto: true, where: 'PriceCharting', usd: 13.2, quotes: { pricecharting: 13.2 } }] });
    const r = await request(app).post('/api/admin/pricing/purge-pricecharting').expect(200);
    expect(r.body).toEqual({ cards: 1, prices: 1, removed: 1, pictures: 0, pricecharting: { set: false, savedAt: null } });
    expect(token.read()).toBeNull();
    expect(store.get('cards', 'c1')).toMatchObject({ prices: [], pricing: { source: 'none', id: null } });
  });

  it('lets administrators change the schedule and leave Cardmarket out, with the old "Use PriceCharting" choice gone', async () => {
    fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify({ pricing: { enabled: true, hour: 5, pricecharting: false, cardmarket: true } }));
    const { app } = setup(fakeNet(), { token: 'c'.repeat(40) });
    expect((await request(app).get('/api/admin/pricing').expect(200)).body.schedule).toMatchObject({ pricecharting: true, cardmarket: true });
    expect((await request(app).put('/api/admin/pricing').send({ enabled: true, hour: 7, cardmarket: false }).expect(200)).body.schedule).toMatchObject({ hour: 7, cardmarket: false });
    expect(new Config(dir).get().pricing).toEqual({ enabled: true, hour: 7, cardmarket: false });
    await request(app).put('/api/admin/pricing').send({ enabled: true, hour: 7, pricecharting: false }).expect(400);
  });
});
