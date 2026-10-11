import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { CardDetails, DETAILS_VERSION } from '../server/details';
import { MasterSets, namesPokemon, placeholderCards, variantText } from '../server/masterset';
import { type TcgdexCard, chooseVariant } from '../server/pricing/catalog';
import { type Fetcher, retryPolicy } from '../server/pricing/sources';
import { Store } from '../server/store';

retryPolicy.baseMs = 1;

// Real TCGdex responses for every Farfetch'd card (tests/fixtures/tcgdex), replayed by URL.
const FIXTURES = path.join(__dirname, 'fixtures/tcgdex');
const API = 'https://api.tcgdex.net/v2/en';
const fixture = (p: string) => path.join(FIXTURES, encodeURIComponent(p) + '.json');
function replay(calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const file = fixture(url.replace(API, ''));
    if (!fs.existsSync(file)) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
const down: Fetcher = async () => {
  throw new Error('getaddrinfo ENOTFOUND api.tcgdex.net');
};

describe("a Pokémon's cards, by name", () => {
  it('takes whole words, however they are written', () => {
    for (const name of ["Farfetch'd", 'Farfetch’d', "Galarian Farfetch'd", "Farfetch'd V"]) expect(namesPokemon(name, "farfetch'd")).toBe(true);
    for (const name of ['Pikachu VMAX', "Ash's Pikachu", 'Pikachu & Zekrom GX']) expect(namesPokemon(name, 'Pikachu')).toBe(true);
    expect(namesPokemon('Mewtwo', 'Mew')).toBe(false);
    expect(namesPokemon('Mime Jr.', 'Mr. Mime')).toBe(false);
    expect(namesPokemon("Sabrina's Mr. Mime", 'Mr Mime')).toBe(true);
    expect(namesPokemon('Flabébé', 'Flabebe')).toBe(true);
    expect(namesPokemon('Pikachu', '')).toBe(false);
  });
});

describe('finding a master set', () => {
  it("lists every card in every variant, oldest first, without TCG Pocket's", async () => {
    const m = await new MasterSets(new CardDetails({ fetcher: replay() })).find("farfetch'd");
    expect(m).toMatchObject({ pokemon: "Farfetch'd", dexId: 83, cards: 20 });
    expect(m.entries).toHaveLength(34);
    expect(m.entries.slice(0, 5).map((e) => [e.set, e.number, e.variant])).toEqual([
      ['Base Set', '27/102', ''],
      ['Base Set', '27/102', '1st Edition Shadowless'],
      ['Base Set', '27/102', 'Shadowless'],
      ['Base Set', '27/102', '1999-2000 Copyright'],
      ['Base Set 2', '40/130', ''],
    ]);
    expect(m.entries[0]).toMatchObject({ tcgdexId: 'base1-27', name: "Farfetch'd", setCode: 'BS', rarity: 'Uncommon', artist: 'Ken Sugimori', released: '1999-01-09' });
    // A modern card: the regular one and its reverse holo.
    expect(m.entries.filter((e) => e.tcgdexId === 'sv03.5-083').map((e) => [e.number, e.variant])).toEqual([
      ['083/165', ''],
      ['083/165', 'Reverse Holo'],
    ]);
    expect(m.entries.some((e) => /^(?:[AB]\d+[a-z]?|P-[AB])$/.test(e.setId))).toBe(false);
    const dates = m.entries.map((e) => e.released ?? '9999');
    expect(dates).toEqual([...dates].sort());
  });

  it('names each variant so the daily price update finds that same variant', async () => {
    const m = await new MasterSets(new CardDetails({ fetcher: replay() })).find("Farfetch'd");
    for (const e of m.entries) {
      const card = JSON.parse(fs.readFileSync(fixture(`/cards/${e.tcgdexId}`), 'utf8')) as TcgdexCard;
      const chosen = chooseVariant(card, e.variant).variant;
      expect(chosen, `${e.tcgdexId} ${e.variant}`).not.toBeNull();
      expect(variantText(card, chosen!)).toBe(e.variant);
    }
  });

  it('finds nothing for a name no card has', async () => {
    const m = await new MasterSets(new CardDetails({ fetcher: replay() })).find('Notapokemon');
    expect(m).toMatchObject({ cards: 0, entries: [] });
  });
});

describe('placeholder cards', () => {
  it('fill the pages in order, matched to their TCGdex card', async () => {
    const m = await new MasterSets(new CardDetails({ fetcher: replay() })).find("Farfetch'd");
    const cards = placeholderCards(m.entries, { binderId: 'b1', pockets: 9, owner: 'Megan', now: '2026-10-11T12:00:00.000Z' });
    expect(cards.map((c) => [c.page, c.slot]).slice(8, 11)).toEqual([
      [1, 9],
      [2, 1],
      [2, 2],
    ]);
    expect(cards[1]).toMatchObject({
      name: "Farfetch'd",
      set: 'Base Set',
      setCode: 'BS',
      number: '27/102',
      variant: '1st Edition Shadowless',
      language: 'English',
      owner: 'Megan',
      placeholder: true,
      status: 'binder',
      binderId: 'b1',
      released: '1999-01-09',
      details: { source: 'tcgdex', result: 'complete', v: DETAILS_VERSION, id: 'base1-27', chosen: true },
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
  const app = (fetcher: Fetcher | null = replay()) => createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../public'), ...(fetcher ? { details: new CardDetails({ fetcher }) } : {}) });

  it('previews, then makes a binder of placeholders for the owner', async () => {
    store.set('binders', 'old', { name: 'Binder 1', pockets: 9, order: 3 });
    const a = app();
    const p = await request(a).get('/api/master-sets/preview').query({ pokemon: "Farfetch'd" }).expect(200);
    expect(p.body).toMatchObject({ pokemon: "Farfetch'd", cards: 20 });
    expect(p.body.entries).toHaveLength(34);

    const r = await request(a).post('/api/master-sets').send({ pokemon: "Farfetch'd", owner: 'Justin', name: "Farfetch'd master set", color: '#2E9B5E', pockets: 16 }).expect(201);
    expect(r.body).toMatchObject({ cards: 34, pages: 3 });
    expect(store.get('binders', r.body.binderId)).toMatchObject({ name: "Farfetch'd master set", color: '#2E9B5E', pockets: 16, kind: 'binder', order: 4 });
    const cards = store.all().cards.filter((c) => (c as { binderId?: string }).binderId === r.body.binderId);
    expect(cards).toHaveLength(34);
    expect(cards.every((c) => (c as { owner?: string }).owner === 'Justin' && (c as { placeholder?: boolean }).placeholder === true)).toBe(true);
    expect(new Set(cards.map((c) => `${(c as { page?: number }).page}/${(c as { slot?: number }).slot}`)).size).toBe(34);
  });

  it('creates nothing for an owner the ledger does not know, or a Pokémon with no cards', async () => {
    const a = app();
    await request(a).post('/api/master-sets').send({ pokemon: "Farfetch'd", owner: 'Someone', name: 'Set', pockets: 9 }).expect(400);
    const r = await request(a).post('/api/master-sets').send({ pokemon: 'Notapokemon', owner: 'Megan', name: 'Set', pockets: 9 }).expect(404);
    expect(r.body.error).toMatch(/No cards of “Notapokemon”/);
    await request(a).post('/api/master-sets').send({ pokemon: "Farfetch'd", owner: 'Megan', name: 'Set', pockets: 10 }).expect(400);
    await request(a).get('/api/master-sets/preview').expect(400);
    expect(store.all().binders).toEqual([]);
    expect(store.all().cards).toEqual([]);
  });

  it('answers 503 when lookups are turned off, and 502 when TCGdex is down', async () => {
    await request(app(null)).get('/api/master-sets/preview').query({ pokemon: 'Pikachu' }).expect(503);
    const r = await request(app(down)).get('/api/master-sets/preview').query({ pokemon: 'Pikachu' }).expect(502);
    expect(r.body.error).toMatch(/TCGdex/);
  });
});
