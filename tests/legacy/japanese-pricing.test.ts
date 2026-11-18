import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhotoFiles as Assets } from '../../src/infrastructure/photos/photo-files.ts';
import { Store } from '../../src/infrastructure/json-store/store.ts';
import { chooseMatch, languageOf, searchQuery } from '../../server/pricing/match.ts';
import { type Candidate, type Fetcher, retryPolicy } from '../../server/pricing/sources.ts';
import { TCGCSV_JAPANESE, TcgCsv } from '../../server/pricing/tcgcsv.ts';
import { PriceUpdater } from '../../server/pricing/updater.ts';

retryPolicy.baseMs = 1;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a card image')]);

/** tcgcsv.com with an English and a Japanese 151 set that both have a Charizard ex numbered 201/165. */
const CATALOG: Record<string, Record<string, unknown[]>> = {
  '3': {
    groups: [{ groupId: 1, name: 'SV: Scarlet & Violet 151', abbreviation: 'MEW', publishedOn: '2023-09-22T00:00:00' }],
    '1/products': [{ productId: 111, groupId: 1, name: 'Charizard ex - 201/165', extendedData: [{ name: 'Number', value: '201/165' }, { name: 'Rarity', value: 'Special Illustration Rare' }] }],
    '1/prices': [{ productId: 111, subTypeName: 'Holofoil', marketPrice: 10 }],
  },
  '85': {
    groups: [{ groupId: 2, name: 'SV2a: Pokemon Card 151', abbreviation: 'SV2a', publishedOn: '2023-06-16T00:00:00' }],
    '2/products': [{ productId: 222, groupId: 2, name: 'Charizard ex - 201/165', imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/222_200w.jpg', extendedData: [{ name: 'Number', value: '201/165' }, { name: 'Rarity', value: 'Special Art Rare' }] }],
    '2/prices': [{ productId: 222, subTypeName: 'Holofoil', marketPrice: 50 }],
  },
};

function net(o: { japaneseDown?: boolean } = {}) {
  const urls: string[] = [];
  const fetcher: Fetcher = async (input) => {
    const url = String(input);
    urls.push(url);
    const m = /tcgplayer\/(\d+)\/(groups|\d+\/(?:products|prices))$/.exec(url);
    if (m) {
      if (m[1] === '85' && o.japaneseDown) return new Response('', { status: 503 });
      const results = CATALOG[m[1]]?.[m[2]];
      return results ? Response.json({ success: true, results }) : new Response('not found', { status: 404 });
    }
    if (url.includes('bankofcanada.ca')) return Response.json({ observations: [{ d: '2026-10-02', FXUSDCAD: { v: '1.4' } }] });
    if (url.endsWith('_in_1000x1000.jpg')) return new Response(new Uint8Array(JPEG), { headers: { 'Content-Type': 'image/jpeg' } });
    return new Response('not found', { status: 404 });
  };
  return { fetcher, urls };
}

const cand = (title: string, set: string, number: string): Candidate => ({ source: 'pricecharting', id: `${title}|${set}`, url: '', title, set, number, usd: 1, thumb: null });

describe('Japanese cards: PriceCharting', () => {
  const english = cand('Charizard ex', 'Pokemon Scarlet & Violet 151', '201');
  const japanese = cand('Charizard ex', 'Pokemon Japanese Scarlet & Violet 151', '201');
  const en = { name: 'Charizard ex', set: 'Scarlet & Violet 151', number: '201/165' };

  it('reads the card language: blank and English are English, Japanese is its own, the rest are others', () => {
    expect(['', undefined, 'English', 'en'].map(languageOf)).toEqual(['english', 'english', 'english', 'english']);
    expect(['Japanese', 'japanese', 'JA'].map(languageOf)).toEqual(['japanese', 'japanese', 'japanese']);
    expect(['Korean', 'Chinese', 'German'].map(languageOf)).toEqual(['other', 'other', 'other']);
  });

  it('matches a Japanese card to the Japanese product and never to the English one with the same number', () => {
    expect(chooseMatch({ ...en, language: 'Japanese' }, [english, japanese]).match).toBe(japanese);
    expect(chooseMatch({ ...en, language: 'Japanese' }, [english]).match).toBeNull();
    expect(chooseMatch({ ...en, language: 'Japanese' }, [english]).candidates).toEqual([]);
  });

  it('matches an English card (or one without a language) to the English product, never the Japanese one', () => {
    expect(chooseMatch(en, [japanese, english]).match).toBe(english);
    expect(chooseMatch({ ...en, language: 'English' }, [japanese, english]).match).toBe(english);
    expect(chooseMatch(en, [japanese]).match).toBeNull();
    expect(chooseMatch(en, [japanese]).candidates).toEqual([]);
  });

  it('never matches a Japanese card to a Korean or Chinese product', () => {
    expect(chooseMatch({ ...en, language: 'Japanese' }, [cand('Charizard ex', 'Pokemon Korean Scarlet & Violet 151', '201')]).match).toBeNull();
  });

  it('adds "Japanese" to the search for a Japanese card only', () => {
    expect(searchQuery({ name: 'Charizard ex', number: '201/165', language: 'Japanese' })).toBe('Charizard ex 201 Japanese');
    expect(searchQuery({ name: 'Charizard ex', number: '201/165', language: 'English' })).toBe('Charizard ex 201');
    expect(searchQuery({ name: 'Charizard ex', number: '201/165' })).toBe('Charizard ex 201');
  });
});

describe("Japanese cards: TCGplayer's catalog (tcgcsv.com category 85)", () => {
  it('asks the Japanese category and finds the card in its own language only', async () => {
    const n = net();
    const ja = new TcgCsv({ fetcher: n.fetcher, gapMs: 0, category: TCGCSV_JAPANESE });
    const q = await ja.quote({ name: 'Charizard ex', set: 'Pokemon Card 151', setCode: 'SV2a', number: '201/165', rarity: 'Special Illustration Rare' });
    expect(q).toMatchObject({ productId: '222', usd: 50, set: 'Pokemon Card 151' });
    expect(n.urls.every((u) => u.includes('/tcgplayer/85/'))).toBe(true);
    // The English set's name doesn't find it in the Japanese catalog.
    expect(await ja.quote({ name: 'Charizard ex', set: 'Scarlet & Violet 151', number: '201/165' })).toBeNull();
    const en = new TcgCsv({ fetcher: n.fetcher, gapMs: 0 });
    expect(await en.quote({ name: 'Charizard ex', set: 'Pokemon Card 151', setCode: 'SV2a', number: '201/165' })).toBeNull();
    expect((await en.quote({ name: 'Charizard ex', set: 'Scarlet & Violet 151', number: '201/165' }))?.productId).toBe('111');
  });
});

describe('the daily update for Japanese cards', () => {
  let dir: string;
  let store: Store;
  let assets: Assets;
  const base = { status: 'binder', prices: [], binderId: 'b1', page: 1, slot: 1, name: 'Charizard ex', number: '201/165' };
  const jp = { ...base, set: 'Pokemon Card 151', setCode: 'SV2a', language: 'Japanese' };
  const us = { ...base, set: 'Scarlet & Violet 151', setCode: 'MEW', language: 'English' };
  const updater = (n: ReturnType<typeof net>) =>
    new PriceUpdater({
      store, assets, fetcher: n.fetcher, now: () => new Date('2026-10-03T15:00:00Z'), delayMs: 0, timeZone: 'America/Vancouver',
      tcgcsv: new TcgCsv({ fetcher: n.fetcher, gapMs: 0 }),
      tcgcsvJapanese: new TcgCsv({ fetcher: n.fetcher, gapMs: 0, category: TCGCSV_JAPANESE }),
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-ja-'));
    store = new Store(dir);
    assets = new Assets(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('prices and pictures each card from its own language, US$ converted to CAD, never the other one', async () => {
    store.set('cards', 'ja', jp);
    store.set('cards', 'en', us);
    store.set('cards', 'unset', { ...us, language: '' });
    const n = net();
    await updater(n).runAll('manual');
    const ja = store.get('cards', 'ja')!;
    expect(ja.pricing).toMatchObject({ source: 'tcgplayer', id: '222' });
    expect(ja.prices).toEqual([expect.objectContaining({ currency: 'CAD', usd: 50, amount: 70, auto: true, quotes: { tcgplayer: 50 } })]);
    expect(ja.officialImageId).toBeTruthy();
    for (const id of ['en', 'unset']) {
      const c = store.get('cards', id)!;
      expect(c.pricing).toMatchObject({ source: 'tcgplayer', id: '111' });
      expect(c.prices).toEqual([expect.objectContaining({ usd: 10, amount: 14 })]);
    }
    expect(n.urls.filter((u) => u.includes('/tcgplayer/85/')).length).toBe(3);
    expect(n.urls.filter((u) => u.includes('/tcgplayer/3/')).length).toBe(3);
  });

  it('keeps a price and picture already entered', async () => {
    const own = { type: 'market', currency: 'CAD', amount: 99, date: '2026-10-03', where: 'me' };
    store.set('cards', 'ja', { ...jp, prices: [own] });
    await updater(net()).runAll('manual');
    expect((store.get('cards', 'ja')!.prices as Record<string, unknown>[])[0]).toMatchObject({ amount: 99, where: 'me' });
  });

  it('skips Korean, Chinese and other languages: no TCGplayer catalog is asked for them', async () => {
    for (const l of ['Korean', 'Chinese', 'German']) store.set('cards', l, { ...jp, language: l });
    const n = net();
    await updater(n).runAll('manual');
    expect(n.urls.filter((u) => u.includes('tcgcsv.com'))).toEqual([]);
    for (const l of ['Korean', 'Chinese', 'German']) expect(store.get('cards', l)!.prices).toEqual([]);
  });

  it("logs a Japanese catalog that doesn't answer and carries on with the other cards", async () => {
    store.set('cards', 'ja', jp);
    store.set('cards', 'en', us);
    const summary = await updater(net({ japaneseDown: true })).runAll('manual');
    expect(summary.counts.updated).toBeGreaterThanOrEqual(1);
    expect(store.get('cards', 'en')!.prices).toEqual([expect.objectContaining({ usd: 10 })]);
    expect(store.get('cards', 'ja')!.prices).toEqual([]);
  });
});
