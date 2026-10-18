import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/compose.ts';
import { Assets } from '../../server/assets.ts';
import { CardDetails } from '../../server/details.ts';
import { CardLookup, variantText } from '../../server/lookup.ts';
import { type TcgdexCard, chooseVariant } from '../../server/pricing/catalog.ts';
import { parseProduct } from '../../server/pricing/pricecharting.ts';
import { type Fetcher, retryPolicy } from '../../server/pricing/sources.ts';
import type { TcgCsvCard } from '../../server/pricing/tcgcsv.ts';
import type { PriceUpdater } from '../../server/pricing/updater.ts';
import { Store } from '../../src/infrastructure/json-store/store.ts';

retryPolicy.baseMs = 1;

const API = 'https://api.tcgdex.net/v2/en';
const CHARIZARD = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/tcgdex-charizard.json'), 'utf8')) as TcgdexCard;

// A small TCGdex: three sets (oldest first, as TCGdex lists them), one of them TCG Pocket's.
const SETS = [
  { id: 'base1', name: 'Base Set', cardCount: { official: 102 } },
  { id: 'base4', name: 'Base Set 2', cardCount: { official: 130 } },
  { id: 'A1', name: 'Genetic Apex', cardCount: { official: 226 } },
  { id: 'sv03.5', name: '151', cardCount: { official: 165 } },
  { id: 'swshp', name: 'SWSH Black Star Promos', cardCount: { official: 307 } },
  { id: '30th', name: '30th Celebration', cardCount: { official: 128 } },
  { id: '30th-c', name: '30th Classic Collection', cardCount: { official: 25 } },
];
const img = (set: string, n: string) => `https://assets.tcgdex.net/en/x/${set}/${n}`;
const CARDS = [
  { id: 'base1-4', localId: '4', name: 'Charizard', image: img('base1', '4') },
  { id: 'base4-4', localId: '4', name: 'Charizard', image: img('base4', '4') },
  { id: 'A1-36', localId: '36', name: 'Charizard', image: img('A1', '36') },
  { id: 'sv03.5-006', localId: '006', name: 'Charizard ex', image: img('sv03.5', '006') },
  { id: 'sv03.5-199', localId: '199', name: 'Charizard ex' },
  { id: 'swshp-SWSH050', localId: 'SWSH050', name: 'Charizard V' },
  { id: 'sv03.5-151', localId: '151', name: 'Charizard' },
];
function tcgdex(calls: string[] = []): Fetcher {
  const routes: Record<string, unknown> = {
    '/sets': SETS,
    '/series/tcgp': { sets: [{ id: 'A1' }] },
    '/sets/base1': { id: 'base1', name: 'Base Set', releaseDate: '1999-01-09', abbreviation: { official: 'BS' } },
    '/cards/base1-4': CHARIZARD,
    // A reprint in a sub-set, which PriceCharting lists under the set it belongs to.
    '/cards/30th-c-4': { ...CHARIZARD, id: '30th-c-4', set: { id: '30th-c', name: '30th Classic Collection', cardCount: { official: 25 } } },
  };
  return async (url) => {
    const p = url.replace(API, '');
    calls.push(p);
    const q = new URL(url).searchParams;
    if (p.startsWith('/cards?name=')) {
      const name = q.get('name')!.toLowerCase();
      return Response.json(CARDS.filter((c) => c.name.toLowerCase().includes(name)));
    }
    if (p.startsWith('/cards?localId=')) return Response.json(CARDS.filter((c) => c.localId.toLowerCase().includes(q.get('localId')!.toLowerCase())));
    if (p in routes) return Response.json(routes[p]);
    return new Response('{"status":404}', { status: 404 });
  };
}
const down: Fetcher = async () => {
  throw new Error('getaddrinfo ENOTFOUND api.tcgdex.net');
};

// PriceCharting's search for "Charizard 4": the Base Set card, its 1st Edition, and Base Set 2's.
const PC = [
  { id: '630', 'product-name': 'Charizard #4', 'console-name': 'Pokemon Base Set', 'loose-price': 40000, 'manual-only-price': 1500000, 'graded-price': 200000 },
  { id: '631', 'product-name': 'Charizard [1st Edition] #4', 'console-name': 'Pokemon Base Set', 'loose-price': 900000 },
  { id: '632', 'product-name': 'Charizard #4', 'console-name': 'Pokemon Base Set 2', 'loose-price': 30000 },
].map(parseProduct);

function fakeUpdater(o: { products?: () => Promise<unknown>; method?: string; eur?: number | null; cardmarket?: boolean; tcgcsv?: (card: TcgCsvCard, product: string | null) => Promise<unknown> } = {}) {
  const lookupProducts = vi.fn(o.products ?? (async () => PC));
  const lookupTcgplayer = vi.fn(o.tcgcsv ?? (async () => null));
  const updater = {
    lookupProducts,
    lookupTcgplayer,
    savedRates: () => ({ usd: 1.4, eur: o.eur === undefined ? 1.6 : o.eur }),
    schedule: () => ({ enabled: true, hour: 5, timeZone: 'UTC', cardmarket: o.cardmarket ?? true }),
    priceMethod: () => ({ method: o.method ?? 'blend', weights: { pricecharting: 40, tcgplayer: 40, cardmarket: 20 }, tolerance: 25 }),
  } as unknown as PriceUpdater;
  return { updater, lookupProducts, lookupTcgplayer };
}

describe('searching for any card', () => {
  it('finds cards by name, exact names first and newest sets first, leaving out TCG Pocket', async () => {
    const lookup = new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }) });
    const { hits, more } = await lookup.search('charizard');
    expect(more).toBe(false);
    expect(hits.map((h) => h.id)).toEqual(['sv03.5-151', 'base4-4', 'base1-4', 'swshp-SWSH050', 'sv03.5-006', 'sv03.5-199']);
    expect(hits[2]).toEqual({ id: 'base1-4', name: 'Charizard', number: '4', total: 102, set: 'Base Set', thumb: `${img('base1', '4')}/low.webp` });
    expect(hits[5].thumb).toBeNull();
  });

  it('narrows by set words and number, wherever they are in the query', async () => {
    const lookup = new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }) });
    expect((await lookup.search('charizard base set 2')).hits.map((h) => h.id)).toEqual(['base4-4']);
    expect((await lookup.search('base set charizard 4/102')).hits.map((h) => h.id)).toEqual(['base1-4']);
    expect((await lookup.search('Charizard ex 6')).hits.map((h) => h.id)).toEqual(['sv03.5-006']);
    // A number can be the card's number or in its set's name: the card's number first.
    expect((await lookup.search('charizard 151')).hits.map((h) => h.id)).toEqual(['sv03.5-151', 'sv03.5-006', 'sv03.5-199']);
    // The set named exactly first.
    expect((await lookup.search('charizard base set')).hits.map((h) => h.id)).toEqual(['base1-4', 'base4-4']);
    expect((await lookup.search('charizard jungle')).hits).toEqual([]);
  });

  it('finds a name among several set and printing words', async () => {
    const calls: string[] = [];
    const lookup = new CardLookup({ details: new CardDetails({ fetcher: tcgdex(calls) }) });
    expect((await lookup.search('charizard base set holo')).hits.map((h) => h.id)).toEqual(['base1-4', 'base4-4']);
    expect((await lookup.search('base set 2 unlimited charizard')).hits.map((h) => h.id)).toEqual(['base4-4']);
    // Printing words aren't searched for.
    expect(calls.some((c) => /holo|unlimited/.test(c))).toBe(false);
  });

  it('leaves out "pokemon" and "card" beside other words, and searches nothing for printing words alone', async () => {
    const calls: string[] = [];
    const lookup = new CardLookup({ details: new CardDetails({ fetcher: tcgdex(calls) }) });
    expect((await lookup.search('pokemon charizard base set 2 card')).hits.map((h) => h.id)).toEqual(['base4-4']);
    expect((await lookup.search('charizard pokemon')).hits.map((h) => h.id)).toContain('base1-4');
    calls.length = 0;
    expect(await lookup.search('1st edition holo')).toEqual({ hits: [], more: false });
    expect(calls).toEqual([]);
  });

  it('finds every card with a number when only a number is typed', async () => {
    const lookup = new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }) });
    expect((await lookup.search('4/130')).hits.map((h) => h.id)).toEqual(['base4-4']);
    expect((await lookup.search('swsh050')).hits.map((h) => h.id)).toEqual(['swshp-SWSH050']);
  });

  it("asks TCGdex only a few times for words that name nothing, and remembers its answers", async () => {
    const calls: string[] = [];
    const lookup = new CardLookup({ details: new CardDetails({ fetcher: tcgdex(calls) }) });
    // At most 6 runs of several words, then each word of 3 letters or more on its own.
    expect((await lookup.search('zzz qq ww ee rr tt')).hits).toEqual([]);
    expect(calls.filter((c) => c.startsWith('/cards?')).length).toBe(7);
    const before = calls.length;
    await lookup.search('charizard');
    await lookup.search('charizard');
    expect(calls.length - before).toBe(1);
  });
});

describe("one card's prices", () => {
  it('names each printing as the Variant field would, so it prices the same printing', () => {
    for (const v of CHARIZARD.variants_detailed!) expect(chooseVariant(CHARIZARD, variantText(v)).variant).toBe(v);
    expect(CHARIZARD.variants_detailed!.map(variantText)).toEqual(['Holo', '1st Edition Shadowless Holo', 'Shadowless Holo', '1999 2000 Copyright Holo']);
    expect(variantText({ type: 'reverse', foil: 'masterball' })).toBe('Master Ball');
    expect(variantText({ type: 'reverse' })).toBe('Reverse Holo');
    expect(variantText({ type: 'normal' })).toBe('');
  });

  it("gives its details and each printing's prices, blended as the daily update would", async () => {
    const { updater, lookupProducts } = fakeUpdater();
    const card = await new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }), updater }).card('base1-4');
    expect(lookupProducts).toHaveBeenCalledWith('Charizard 4');
    expect(card).toMatchObject({ id: 'base1-4', name: 'Charizard', number: '4', total: 102, set: 'Base Set', setCode: 'BS', rarity: 'Rare', artist: 'Mitsuhiro Arita', released: '1999-01-09', notes: [], rates: { usd: 1.4, eur: 1.6 } });
    expect(card.image).toBe('https://assets.tcgdex.net/en/base/base1/4/high.webp');
    const [holo, first] = card.printings;
    expect(holo).toMatchObject({
      label: 'holo',
      variant: 'Holo',
      tcgplayer: { usd: 928.32, url: 'https://www.tcgplayer.com/product/42382' },
      cardmarket: { eur: 432.4 },
      pricecharting: { id: '630', usd: 400, title: 'Charizard' },
      leftOut: null,
    });
    // PriceCharting US$400 is the anchor: TCGplayer's US$928.32 is too far from it, Cardmarket's
    // €432.40 (US$494.17) counts.
    expect(holo.price).toMatchObject({ usd: 418.83, cad: 586.36, where: 'Blend' });
    expect(holo.pricecharting!.grades).toEqual(expect.arrayContaining([{ label: 'PSA 10', usd: 15000, cad: 21000 }, { label: 'Grade 9', usd: 2000, cad: 2800 }]));
    expect(first).toMatchObject({ variant: '1st Edition Shadowless Holo', pricecharting: { id: '631', usd: 9000 } });
  });

  it("still prices a card when PriceCharting can't be asked, and says why", async () => {
    const { updater } = fakeUpdater({ products: async () => Promise.reject(new Error("PriceCharting isn't set up.")) });
    const card = await new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }), updater }).card('base1-4');
    expect(card.notes).toEqual(["No PriceCharting prices: PriceCharting isn't set up."]);
    // TCGplayer is the anchor now; Cardmarket's US$494.17 is too far from it.
    expect(card.printings[0]).toMatchObject({ pricecharting: null, price: { usd: 928.32, cad: 1299.65, where: 'TCGplayer' } });
  });

  it("leaves Cardmarket out without the euro's rate, or when it's turned off, and says so", async () => {
    const lookup = (o: Parameters<typeof fakeUpdater>[0]) => new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }), updater: fakeUpdater(o).updater }).card('base1-4');
    const noRate = await lookup({ eur: null });
    expect(noRate.printings[0].price).toMatchObject({ usd: 400, where: 'PriceCharting' });
    expect(noRate.notes).toEqual(["Cardmarket's prices aren't counted until a price update has the euro's exchange rate."]);
    expect((await lookup({ cardmarket: false })).notes).toEqual(["Cardmarket's prices aren't counted: it's left out under Administration → Prices."]);
  });

  it("keeps PriceCharting's calls for the daily update once lookups have used their share of its budget", async () => {
    const { PriceUpdater, LOOKUP_SHARE } = await import('../../server/pricing/updater.ts');
    const usage = { calls: 0, limit: 100 };
    const search = vi.fn(async () => PC);
    const pricecharting = { ready: true, out: () => null, usageNow: () => usage, search };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-lookup-'));
    try {
      const updater = new PriceUpdater({ store: new Store(tmp), assets: {} as Assets, pricecharting: pricecharting as never });
      expect(await updater.lookupProducts('Charizard 4')).toBe(PC);
      usage.calls = Math.floor(usage.limit * LOOKUP_SHARE);
      await expect(updater.lookupProducts('Charizard 4')).rejects.toThrow("today's PriceCharting calls (75 of 100) are kept for the daily price update");
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prices a card from the card database alone on a server without automatic prices', async () => {
    const card = await new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }) }).card('base1-4');
    expect(card.notes).toEqual(["Cardmarket's prices aren't counted until a price update has the euro's exchange rate."]);
    expect(card.rates).toEqual({ usd: 1.37, eur: null });
    expect(card.printings[0]).toMatchObject({ pricecharting: null, price: { usd: 928.32, cad: 1271.8, where: 'TCGplayer' } });
  });

  it("asks TCGplayer's own catalog for a printing the card database has no TCGplayer price for, as the daily update does", async () => {
    const { updater, lookupTcgplayer } = fakeUpdater({ tcgcsv: async (_card, product) => (product === '106999' ? { productId: '106999', usd: 12000, name: 'Charizard', number: '4/102', set: 'Base Set', url: '', rarity: null, released: null } : null) });
    const card = await new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }), updater }).card('base1-4');
    // Only the printings without a TCGplayer price are looked for, by their own TCGplayer product.
    expect(lookupTcgplayer).toHaveBeenCalledTimes(3);
    expect(lookupTcgplayer).toHaveBeenCalledWith(expect.objectContaining({ name: 'Charizard', number: '4/102', set: 'Base Set', setCode: 'BS', variant: '1st Edition Shadowless Holo' }), '106999');
    expect(card.printings[1]).toMatchObject({ variant: '1st Edition Shadowless Holo', tcgplayer: { usd: 12000, url: 'https://www.tcgplayer.com/product/106999' } });
    expect(card.printings[0].tcgplayer).toMatchObject({ usd: 928.32 });
  });

  it("says when TCGplayer's catalog didn't answer, and still prices the card from the other sources", async () => {
    const { updater } = fakeUpdater({ tcgcsv: async () => Promise.reject(new Error('tcgcsv.com answered 503')) });
    const card = await new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }), updater }).card('base1-4');
    const missing = card.printings.slice(1).map((p) => p.label);
    expect(card.notes).toEqual([`No TCGplayer price from TCGplayer's catalog (tcgcsv.com) for the ${missing.join(', ')} printings: it didn't answer (tcgcsv.com answered 503).`]);
    // TCGdex's TCGplayer and Cardmarket prices and PriceCharting's match are as before.
    expect(card.printings[0]).toMatchObject({ tcgplayer: { usd: 928.32 }, cardmarket: { eur: 432.4 }, pricecharting: { id: '630', usd: 400 }, price: { usd: 418.83, where: 'Blend' } });
    expect(card.printings[1]).toMatchObject({ tcgplayer: null, pricecharting: { id: '631', usd: 9000 } });
  });

  it("lets a lookup tell a tcgcsv.com failure from a card TCGplayer's catalog doesn't have", async () => {
    const { PriceUpdater } = await import('../../server/pricing/updater.ts');
    const quote = vi.fn(async () => Promise.reject(new Error('tcgcsv.com answered 503')));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-lookup-'));
    try {
      const updater = new PriceUpdater({ store: new Store(tmp), assets: {} as Assets, tcgcsv: { quote } as never });
      const card = { name: 'Charizard', set: 'Base Set', setCode: 'BS', number: '4/102', variant: 'Holo', rarity: 'Rare', tcgdexSet: 'Base Set' };
      await expect(updater.lookupTcgplayer(card, null)).rejects.toThrow('tcgcsv.com answered 503');
      quote.mockResolvedValueOnce(null as never);
      expect(await updater.lookupTcgplayer(card, null)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches a reprint sub-set's card on PriceCharting under the set it belongs to, counting the card database's prices", async () => {
    const products = [parseProduct({ id: '700', 'product-name': 'Charizard #4', 'console-name': 'Pokemon 30th Celebration', 'loose-price': 90000 })];
    const { updater } = fakeUpdater({ products: async () => products });
    const card = await new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }), updater }).card('30th-c-4');
    expect(card.printings[0]).toMatchObject({ pricecharting: { id: '700', usd: 900 }, leftOut: null, price: { where: 'Blend' } });
  });

  it('says when PriceCharting has no certain match', async () => {
    const { updater } = fakeUpdater({ products: async () => [] });
    const card = await new CardLookup({ details: new CardDetails({ fetcher: tcgdex() }), updater }).card('base1-4');
    expect(card.notes).toEqual(['PriceCharting has no certain match for this card.']);
  });
});

describe('the lookup API', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-lookup-'));
    store = new Store(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = (details?: CardDetails, updater?: PriceUpdater) => createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public'), details, updater });

  it('searches and shows a card without changing the ledger', async () => {
    const { updater } = fakeUpdater();
    const a = app(new CardDetails({ fetcher: tcgdex() }), updater);
    const before = JSON.stringify(store.all());
    const s = await request(a).get('/api/lookup/search').query({ q: 'charizard 4/102' }).expect(200);
    expect(s.body.hits.map((h: { id: string }) => h.id)).toEqual(['base1-4']);
    const c = await request(a).get('/api/lookup/cards/base1-4').expect(200);
    expect(c.body).toMatchObject({ name: 'Charizard', printings: [{ variant: 'Holo' }, {}, {}, {}] });
    expect(JSON.stringify(store.all())).toBe(before);
    await request(a).get('/api/lookup/search').query({ q: ' ' }).expect(400);
    await request(a).get('/api/lookup/cards/no-such-card').expect(404);
    await request(a).get('/api/lookup/cards/bad%20id').expect(404);
  });

  it('answers 503 when lookups are turned off, and 502 when TCGdex is down', async () => {
    await request(app()).get('/api/lookup/search').query({ q: 'pikachu' }).expect(503);
    await request(app()).get('/api/lookup/cards/base1-4').expect(503);
    const r = await request(app(new CardDetails({ fetcher: down }))).get('/api/lookup/search').query({ q: 'pikachu' }).expect(502);
    expect(r.body.error).toMatch(/Couldn't reach api\.tcgdex\.net/);
  });
});
