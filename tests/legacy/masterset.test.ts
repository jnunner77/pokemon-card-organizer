import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import { Assets } from '../../server/assets.ts';
import { CardDetails, DETAILS_VERSION } from '../../server/details.ts';
import { MasterSets, groupOf, isExtra, placeholderCards, subGroupsOf, tcgVariant, variantText } from '../../server/masterset.ts';
import { type TcgdexCard, chooseVariant } from '../../server/pricing/catalog.ts';
import { type Fetcher, retryPolicy } from '../../server/pricing/sources.ts';
import { TcgCsv, type TcgGroup } from '../../server/pricing/tcgcsv.ts';
import { Store } from '../../server/store.ts';

retryPolicy.baseMs = 1;

// Real TCGdex responses for Celebrations and its Classic Collection (tests/fixtures/tcgdex), replayed by URL.
const FIXTURES = path.join(__dirname, 'fixtures/tcgdex');
const API = 'https://api.tcgdex.net/v2/en';
const fixture = (p: string) => path.join(FIXTURES, encodeURIComponent(p) + '.json');
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fixtureJson = <T>(p: string) => JSON.parse(fs.readFileSync(fixture(p), 'utf8')) as T;

/**
 * TCGplayer's catalog as tcgcsv.com serves it, for Celebrations: each card as TCGdex has it, holofoil,
 * plus a reverse holo of Ho-Oh, a plain printing of Reshiram, and a 26th card that TCGdex doesn't
 * list (made up, to be found).
 */
function tcgplayer(): Record<string, unknown> {
  const cards = fixtureJson<{ cards: { localId: string; name: string }[] }>('/sets/cel25').cards;
  const products = [...cards, { localId: '26', name: 'Missingno' }].map((c, i) => ({ productId: 1000 + i, groupId: 1, name: c.localId === '26' ? 'Missingno - 26/25' : c.name, extendedData: [{ name: 'Number', value: `${c.localId}/25` }, { name: 'Rarity', value: 'Holo Rare' }] }));
  const prices = [...products.map((p) => ({ productId: p.productId, subTypeName: 'Holofoil', marketPrice: 1 })), { productId: 1000, subTypeName: 'Reverse Holofoil', marketPrice: 5 }, { productId: 1001, subTypeName: 'Normal', marketPrice: 2 }];
  const groups: TcgGroup[] = [
    { groupId: 1, name: 'Celebrations' },
    { groupId: 2, name: 'Celebrations: Classic Collection' },
    { groupId: 3, name: 'SV: Scarlet & Violet 151' },
  ];
  return { '/groups': groups, '/1/products': products, '/1/prices': prices, '/2/products': [], '/2/prices': [] };
}

function replay(calls: string[] = []): Fetcher {
  const catalog = tcgplayer();
  return async (url) => {
    calls.push(url);
    if (url.startsWith('https://tcgcsv.com/tcgplayer/3')) {
      const body = catalog[url.replace('https://tcgcsv.com/tcgplayer/3', '')];
      return body ? json({ success: true, results: body }) : new Response('', { status: 404 });
    }
    const file = fixture(url.replace(API, ''));
    if (!fs.existsSync(file)) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
const down: Fetcher = async () => {
  throw new Error('getaddrinfo ENOTFOUND api.tcgdex.net');
};

describe("a set's master set", () => {
  it('lists every card of the set and its sub-sets, in number order', async () => {
    const m = await new MasterSets(new CardDetails({ fetcher: replay() })).findSet('celebrations');
    expect(m).toMatchObject({ title: 'Celebrations', setId: 'cel25', cards: 50, tcgplayer: { checked: false } });
    expect(m!.entries).toHaveLength(50);
    expect(m!.entries.slice(0, 2).map((e) => [e.setId, e.number, e.name, e.variant])).toEqual([
      ['cel25', '1/25', 'Ho-Oh', ''],
      ['cel25', '2/25', 'Reshiram', ''],
    ]);
    // Its Classic Collection follows its own cards.
    expect(m!.entries.slice(-1).map((e) => [e.setId, e.number, e.name])).toEqual([['cel25cc', 'CC025', 'Tapu Lele GX']]);
    expect(m!.entries.filter((e) => e.extra).map((e) => e.variant)).toEqual(['25th Celebration Holo', '25th Celebration Holo']);
  });

  it('names each variant so the daily price update finds that same variant', async () => {
    const m = await new MasterSets(new CardDetails({ fetcher: replay() })).findSet('Celebrations');
    for (const e of m!.entries) {
      const card = fixtureJson<TcgdexCard>(`/cards/${e.tcgdexId}`);
      const chosen = chooseVariant(card, e.variant).variant;
      expect(chosen, `${e.tcgdexId} ${e.variant}`).not.toBeNull();
      expect(variantText(card, chosen!)).toBe(e.variant);
    }
  });

  it("adds the printings TCGplayer's catalog lists and TCGdex doesn't, matched to their product", async () => {
    const fetcher = replay();
    const m = await new MasterSets(new CardDetails({ fetcher }), new TcgCsv({ fetcher, gapMs: 0 })).findSet('Celebrations');
    expect(m!.tcgplayer).toEqual({ checked: true, added: 3, sets: ['Celebrations', 'Celebrations: Classic Collection'] });
    expect(m!.cards).toBe(51);
    expect(m!.entries).toHaveLength(53);
    // Ho-Oh's reverse holo, after its regular card; Reshiram's plain printing (TCGdex only has its
    // holo), named so; and the card TCGdex doesn't list, in number order.
    expect(m!.entries.slice(0, 4).map((e) => [e.number, e.name, e.variant, e.tcgdexId, e.tcgplayerId])).toEqual([
      ['1/25', 'Ho-Oh', '', 'cel25-1', null],
      ['1/25', 'Ho-Oh', 'Reverse Holo', 'cel25-1', '1000'],
      ['2/25', 'Reshiram', '', 'cel25-2', null],
      ['2/25', 'Reshiram', 'Non-Holo', 'cel25-2', '1001'],
    ]);
    expect(m!.entries.find((e) => e.name === 'Missingno')).toMatchObject({ setId: 'cel25', number: '26/25', variant: 'Holo', tcgdexId: null, tcgplayerId: '1025', rarity: 'Holo Rare', extra: false, thumb: 'https://tcgplayer-cdn.tcgplayer.com/product/1025_in_200x200.jpg' });
    expect(m!.entries.findIndex((e) => e.name === 'Missingno')).toBe(27);
    // Their placeholders are matched to TCGplayer's product; Missingno has no TCGdex match to start from.
    const cards = placeholderCards(m!.entries, { binderId: 'b1', pockets: 9, owner: 'Megan', now: '2026-10-11T12:00:00.000Z' });
    expect(cards[1]).toMatchObject({ variant: 'Reverse Holo', details: { id: 'cel25-1' }, pricing: { source: 'tcgplayer', id: '1000', linkedBy: 'auto', title: 'Ho-Oh [Reverse Holo]' } });
    expect(cards[27]).toMatchObject({ name: 'Missingno', details: null, pricing: { source: 'tcgplayer', id: '1025' } });
    expect(cards[0].pricing).toBeUndefined();
  });

  it("says when TCGplayer's catalog couldn't be checked, and still lists TCGdex's cards", async () => {
    const tcgdex = replay();
    const fetcher: Fetcher = async (url, init) => (url.startsWith('https://tcgcsv.com') ? new Response('', { status: 503 }) : tcgdex(url, init));
    const m = await new MasterSets(new CardDetails({ fetcher }), new TcgCsv({ fetcher, gapMs: 0 })).findSet('Celebrations');
    expect(m!.tcgplayer).toMatchObject({ checked: false, error: expect.stringMatching(/tcgcsv\.com/) });
    expect(m!.entries).toHaveLength(50);
  });

  it('finds the set by its id too, and nothing for a set that does not exist', async () => {
    const ms = new MasterSets(new CardDetails({ fetcher: replay() }));
    expect((await ms.findSet('cel25'))?.title).toBe('Celebrations');
    expect(await ms.findSet('Not a set')).toBeNull();
    expect((await ms.sets()).some((x) => /^(?:[AB]\d+[a-z]?|P-[AB])$/.test(x.id))).toBe(false);
  });
});

describe('promo printings', () => {
  const v = (type: string, foil?: string, stamp?: string[], subtype?: string) => ({ type, foil, stamp, subtype });
  it('are stamped, metal, or a foil on a card that also comes plain', () => {
    const regular = v('normal'), reverse = v('reverse'), ball = v('reverse', 'pokeball'), master = v('reverse', 'masterball');
    const stamped = v('normal', undefined, ['gamestop']), cosmos = v('holo', 'cosmos'), metal = v('metal', 'gold');
    const all = [regular, reverse, ball, master, stamped, cosmos, metal];
    expect(all.map((x) => isExtra(x, all))).toEqual([false, false, false, false, true, true, true]);
    // 1st Edition is part of the set; a holo that is only ever galaxy foil (Fossil) is the card itself.
    const galaxy = v('normal', 'galaxy'), first = v('normal', 'galaxy', ['1st-edition']), print4 = v('normal', undefined, undefined, '1999-2000-copyright');
    expect([galaxy, first, print4].map((x) => isExtra(x, [galaxy, first, print4]))).toEqual([false, false, false]);
    // The EX era's reverse holos carry the set's logo (Team Rocket Returns): the set's own, unless there's a plain one too.
    const logo = v('reverse', undefined, ['set-logo']);
    expect(isExtra(logo, [regular, logo])).toBe(false);
    expect(isExtra(logo, [regular, reverse, logo])).toBe(true);
  });
});

describe("TCGplayer's catalog", () => {
  it('names its printings as Variants', () => {
    expect(tcgVariant('', 'Normal')).toBe('');
    expect(tcgVariant('', 'Holofoil')).toBe('Holo');
    expect(tcgVariant('', 'Reverse Holofoil')).toBe('Reverse Holo');
    expect(tcgVariant('', '1st Edition Holofoil')).toBe('1st Edition Holo');
    expect(tcgVariant('Poke Ball Pattern', 'Holofoil')).toBe('Poke Ball Pattern');
    expect(tcgVariant('Poke Ball Pattern', 'Reverse Holofoil')).toBe('Poke Ball Pattern Reverse Holo');
    expect(tcgVariant('Reverse Holofoil', 'Reverse Holofoil')).toBe('Reverse Holo');
  });

  it("finds the set by TCGdex's name for it", () => {
    const groups: TcgGroup[] = [
      ...['SV: Scarlet & Violet 151', 'SWSH11: Lost Origin', 'SWSH11: Lost Origin Trainer Gallery', 'Hidden Fates', 'Hidden Fates: Shiny Vault', 'Base Set', 'Base Set 2', 'Base Set (Shadowless)'],
      ...['Black and White', 'XY - Evolutions', 'SV: Prismatic Evolutions', 'SV01: Scarlet & Violet Base Set', 'EX Ruby and Sapphire', "McDonald's Promos 2019", 'SM Base Set', 'Generations', 'Generations: Radiant Collection'],
    ].map((name, i) => ({ groupId: i, name }));
    const of = (n: string, id = 'x') => groupOf(groups, id, n)?.name ?? null;
    expect(of('151')).toBe('SV: Scarlet & Violet 151');
    expect(of('Lost Origin')).toBe('SWSH11: Lost Origin');
    expect(of('Lost Origin Trainer Gallery')).toBe('SWSH11: Lost Origin Trainer Gallery');
    expect(of('Hidden Fates Shiny Vault')).toBe('Hidden Fates: Shiny Vault');
    expect(of('Base Set')).toBe('Base Set');
    expect(of('Jungle')).toBeNull();
    // Written another way on TCGplayer.
    expect(of('Black & White')).toBe('Black and White');
    expect(of('Evolutions')).toBe('XY - Evolutions');
    expect(of('Scarlet & Violet')).toBe('SV01: Scarlet & Violet Base Set');
    expect(of('Ruby & Sapphire')).toBe('EX Ruby and Sapphire');
    expect(of("McDonald's Collection 2019")).toBe("McDonald's Promos 2019");
    expect(of('Sun & Moon', 'sm1')).toBe('SM Base Set');
    // A sub-set TCGdex keeps in the set itself.
    expect(of('Generations')).toBe('Generations');
    expect(subGroupsOf(groups, 'Generations').map((g) => g.name)).toEqual(['Generations: Radiant Collection']);
    expect(subGroupsOf(groups, 'Hidden Fates').map((g) => g.name)).toEqual(['Hidden Fates: Shiny Vault']);
  });
});

describe('placeholder cards', () => {
  it('fill the pages in order, matched to their TCGdex card', async () => {
    const m = await new MasterSets(new CardDetails({ fetcher: replay() })).findSet('Celebrations');
    const cards = placeholderCards(m!.entries, { binderId: 'b1', pockets: 9, owner: 'Megan', now: '2026-10-11T12:00:00.000Z' });
    expect(cards.map((c) => [c.page, c.slot]).slice(8, 11)).toEqual([
      [1, 9],
      [2, 1],
      [2, 2],
    ]);
    expect(cards[0]).toMatchObject({
      name: 'Ho-Oh',
      set: 'Celebrations',
      number: '1/25',
      variant: '',
      language: 'English',
      owner: 'Megan',
      placeholder: true,
      status: 'binder',
      binderId: 'b1',
      details: { source: 'tcgdex', result: 'complete', v: DETAILS_VERSION, id: 'cel25-1', chosen: true },
    });
  });
});

describe('master sets in the app', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-masterset-'));
    store = new Store(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = (fetcher: Fetcher | null = replay()) => createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public'), ...(fetcher ? { details: new CardDetails({ fetcher }) } : {}) });

  it("makes a set's master set, leaving promo printings out unless asked", async () => {
    store.set('binders', 'old', { name: 'Binder 1', pockets: 9, order: 3 });
    const a = app();
    expect((await request(a).get('/api/master-sets/sets').expect(200)).body.sets).toContainEqual({ id: 'cel25', name: 'Celebrations', total: 25 });
    const p = await request(a).get('/api/master-sets/preview').query({ set: 'Celebrations' }).expect(200);
    expect(p.body).toMatchObject({ title: 'Celebrations', cards: 50 });
    const r = await request(a).post('/api/master-sets').send({ set: 'Celebrations', owner: 'Maiya', name: 'Celebrations master set', pockets: 9 }).expect(201);
    expect(r.body).toMatchObject({ cards: 48, pages: 6 });
    expect(store.get('binders', r.body.binderId)).toMatchObject({ name: 'Celebrations master set', pockets: 9, kind: 'binder', owner: 'Maiya', order: 4 });
    const cards = store.all().cards.filter((c) => (c as { binderId?: string }).binderId === r.body.binderId);
    expect(cards).toHaveLength(48);
    expect(cards.every((c) => (c as { owner?: string }).owner === 'Maiya' && (c as { placeholder?: boolean }).placeholder === true)).toBe(true);
    expect(new Set(cards.map((c) => `${(c as { page?: number }).page}/${(c as { slot?: number }).slot}`)).size).toBe(48);
    const all = await request(a).post('/api/master-sets').send({ set: 'cel25', owner: 'Maiya', name: 'Celebrations everything', pockets: 9, extras: true }).expect(201);
    expect(all.body.cards).toBe(50);
    await request(a).get('/api/master-sets/preview').query({ set: 'Not a set' }).expect(404);
  });

  it('checks the set against TCGplayer when the server has its catalog', async () => {
    const fetcher = replay();
    const a = createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public'), details: new CardDetails({ fetcher }), tcgcsv: new TcgCsv({ fetcher, gapMs: 0 }) });
    const p = await request(a).get('/api/master-sets/preview').query({ set: 'Celebrations' }).expect(200);
    expect(p.body).toMatchObject({ cards: 51, tcgplayer: { checked: true, added: 3 } });
    const r = await request(a).post('/api/master-sets').send({ set: 'Celebrations', owner: 'Megan', name: 'Celebrations', pockets: 9 }).expect(201);
    expect(r.body.cards).toBe(51);
    expect(store.all().cards.filter((c) => (c as { pricing?: { source?: string } }).pricing?.source === 'tcgplayer')).toHaveLength(3);
  });

  it('creates nothing for an owner the ledger does not know, a set that does not exist, or a Pokémon', async () => {
    const a = app();
    await request(a).post('/api/master-sets').send({ set: 'Celebrations', owner: 'Someone', name: 'Set', pockets: 9 }).expect(400);
    const r = await request(a).post('/api/master-sets').send({ set: 'Not a set', owner: 'Megan', name: 'Set', pockets: 9 }).expect(404);
    expect(r.body.error).toMatch(/No set called “Not a set”/);
    await request(a).post('/api/master-sets').send({ set: 'Celebrations', owner: 'Megan', name: 'Set', pockets: 10 }).expect(400);
    // Master sets of a Pokémon are gone: TCGdex misses too many of its printings.
    await request(a).post('/api/master-sets').send({ pokemon: "Farfetch'd", owner: 'Megan', name: 'Set', pockets: 9 }).expect(400);
    await request(a).get('/api/master-sets/preview').query({ pokemon: 'Pikachu' }).expect(400);
    expect(store.all().binders).toEqual([]);
    expect(store.all().cards).toEqual([]);
  });

  it('answers 503 when lookups are turned off, and 502 when TCGdex is down', async () => {
    await request(app(null)).get('/api/master-sets/preview').query({ set: '151' }).expect(503);
    const r = await request(app(down)).get('/api/master-sets/preview').query({ set: '151' }).expect(502);
    expect(r.body.error).toMatch(/TCGdex/);
  });
});
