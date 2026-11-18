import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createCardLookups } from '../../src/compose.ts';
import { TcgdexCardDatabase } from '../../src/infrastructure/catalog/tcgdex.ts';
import { PhotoFiles as Assets } from '../../src/infrastructure/photos/photo-files.ts';
import { Store } from '../../src/infrastructure/json-store/store.ts';
import { Catalog } from '../../server/pricing/catalog.ts';
import { type Fetcher, retryPolicy } from '../../server/pricing/sources.ts';
import { TCGCSV_JAPANESE, TcgCsv } from '../../server/pricing/tcgcsv.ts';
import { PriceUpdater } from '../../server/pricing/updater.ts';

retryPolicy.baseMs = 1;
const NOW = new Date('2026-10-03T15:00:00Z');

/** tcgcsv.com's Japanese catalog with a Japanese 151 set holding a Charizard ex numbered 201/165, and TCGdex's Japanese API for its illustrator. */
const CATALOG: Record<string, unknown[]> = {
  groups: [{ groupId: 2, name: 'SV2a: Pokemon Card 151', abbreviation: 'SV2a', publishedOn: '2023-06-16T00:00:00', modifiedOn: 'm1' }],
  '2/products': [{ productId: 222, groupId: 2, name: 'Charizard ex - 201/165', extendedData: [{ name: 'Number', value: '201/165' }, { name: 'Rarity', value: 'Special Art Rare' }] }],
  '2/prices': [{ productId: 222, subTypeName: 'Holofoil', marketPrice: 50 }],
};

function net() {
  const urls: string[] = [];
  const fetcher: Fetcher = async (input) => {
    const url = String(input);
    urls.push(url);
    const m = /tcgplayer\/85\/(groups|\d+\/(?:products|prices))$/.exec(url);
    if (m) return Response.json({ success: true, results: CATALOG[m[1] ?? ''] ?? [] });
    if (url === 'https://api.tcgdex.net/v2/ja/cards/SV2a-201') return Response.json({ id: 'SV2a-201', localId: '201', name: 'Charizard ex', illustrator: 'miki kudo', set: { id: 'SV2a', name: '151' } });
    if (url.includes('bankofcanada.ca')) return Response.json({ observations: [{ d: '2026-10-02', FXUSDCAD: { v: '1.4' } }] });
    return new Response('not found', { status: 404 });
  };
  return { fetcher, urls };
}

describe('Japanese card details over HTTP', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-ja-details-'));
    store = new Store(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** The app with the Japanese index built, as the server builds it in the background. */
  async function app(n = net()) {
    const tcgcsvJapanese = new TcgCsv({ fetcher: n.fetcher, gapMs: 0, category: TCGCSV_JAPANESE });
    const database = new TcgdexCardDatabase({ fetcher: n.fetcher });
    const lookups = createCardLookups({ store, database, tcgcsvJapanese, japaneseDatabase: new TcgdexCardDatabase({ fetcher: n.fetcher, language: 'ja' }), now: () => NOW, backfillAfterMs: null });
    await lookups.refreshJapaneseCatalog.execute();
    lookups.refreshJapaneseCatalog.stop();
    return { app: createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public'), cardLookups: lookups }), n, tcgcsvJapanese, database };
  }

  it('looks a Japanese card up by name and number after the index is built, and never before', async () => {
    const n = net();
    const tcgcsvJapanese = new TcgCsv({ fetcher: n.fetcher, gapMs: 0, category: TCGCSV_JAPANESE });
    const early = createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public'), cardLookups: createCardLookups({ store, database: new TcgdexCardDatabase({ fetcher: n.fetcher }), tcgcsvJapanese, now: () => NOW }) });
    const wait = await request(early).get('/api/cards/lookup').query({ name: 'Charizard ex', number: '201/165', lang: 'ja' }).expect(503);
    expect(wait.body.error).toMatch(/still being downloaded \(0 of 0 sets\)/);
    const { app: built } = await app();
    const r = await request(built).get('/api/cards/lookup').query({ name: 'Charizard ex', number: '201/165', lang: 'ja' }).expect(200);
    expect(r.body.matches).toEqual([expect.objectContaining({ id: 'ja-2-222', set: 'Pokemon Card 151', setCode: 'SV2a', rarity: 'Special Art Rare', artist: 'miki kudo', released: '2023-06-16' })]);
    await request(built).get('/api/lookup/search').query({ q: 'charizard', lang: 'ja' }).expect(200);
    await request(built).get('/api/cards/lookup').query({ name: 'Charizard ex', number: '201/165', lang: 'xx' }).expect(400);
  });

  it('refuses a Japanese match for an English card and an English match for a Japanese one', async () => {
    const { app: a } = await app();
    store.set('cards', 'en', { name: 'Charizard ex', number: '201/165', language: 'English' });
    store.set('cards', 'ja', { name: 'Charizard ex', number: '201/165', language: 'Japanese' });
    await request(a).post('/api/cards/en/details').send({ id: 'ja-2-222' }).expect(400);
    await request(a).post('/api/cards/ja/details').send({ id: 'sv03.5-006' }).expect(400);
    const ok = await request(a).post('/api/cards/ja/details').send({ id: 'ja-2-222' }).expect(200);
    expect(ok.body.card).toMatchObject({ set: 'Pokemon Card 151', setCode: 'SV2a', artist: 'miki kudo' });
  });

  it('prices a Japanese card by its product in the daily update, never asking TCGdex English about its id', async () => {
    const n = net();
    const { tcgcsvJapanese } = await app(n);
    store.set('cards', 'ja', { name: 'Charizard ex', number: '201/165', set: 'Pokemon Card 151', setCode: 'SV2a', language: 'Japanese', status: 'binder', prices: [], binderId: 'b1', page: 1, slot: 1, details: { source: 'tcgdex', result: 'filled', v: 3, id: 'ja-2-222', checkedAt: NOW.toISOString() } });
    const updater = new PriceUpdater({ store, assets: new Assets(dir), fetcher: n.fetcher, now: () => NOW, delayMs: 0, timeZone: 'America/Vancouver', catalog: new Catalog({ fetcher: n.fetcher }), tcgcsvJapanese });
    n.urls.length = 0;
    await updater.runAll('manual');
    expect(n.urls.some((u) => u.includes('api.tcgdex.net/v2/en/cards/ja-'))).toBe(false);
    expect(store.get('cards', 'ja')?.pricing).toMatchObject({ source: 'tcgplayer', id: '222' });
    expect(store.get('cards', 'ja')?.prices).toEqual([expect.objectContaining({ usd: 50, currency: 'CAD' })]);
  });

  it('does not price or picture a Japanese card from the English TCGdex card it was once matched to', async () => {
    const n = net();
    const { tcgcsvJapanese } = await app(n);
    store.set('cards', 'ja', { name: 'Charizard ex', number: '201/165', language: 'Japanese', status: 'binder', prices: [], binderId: 'b1', page: 1, slot: 1, details: { source: 'tcgdex', result: 'complete', v: 3, id: 'sv03.5-006', checkedAt: NOW.toISOString() } });
    const updater = new PriceUpdater({ store, assets: new Assets(dir), fetcher: n.fetcher, now: () => NOW, delayMs: 0, timeZone: 'America/Vancouver', catalog: new Catalog({ fetcher: n.fetcher }), tcgcsvJapanese });
    n.urls.length = 0;
    await updater.runAll('manual');
    expect(n.urls.some((u) => u.includes('sv03.5-006'))).toBe(false);
  });
});
