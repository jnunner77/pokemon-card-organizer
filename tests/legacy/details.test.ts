import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, createCardLookups } from '../../src/compose.ts';
import { PhotoFiles as Assets } from '../../src/infrastructure/photos/photo-files.ts';
import { DETAILS_VERSION } from '../../src/domain/cards/attention.ts';
import { wantsDetails } from '../../src/domain/catalog/details.ts';
import { similarity } from '../../src/domain/catalog/names.ts';
import { mapRarity } from '../../src/domain/catalog/rarity.ts';
import { LookUpCard } from '../../src/application/catalog/look-up-card.ts';
import { TcgdexCardDatabase } from '../../src/infrastructure/catalog/tcgdex.ts';
import type { PriceUpdater } from '../../server/pricing/updater.ts';
import { type Fetcher, retryPolicy } from '../../server/pricing/sources.ts';
import { Store } from '../../src/infrastructure/json-store/store.ts';

retryPolicy.baseMs = 1;

// Real TCGdex responses recorded for these cards (tests/fixtures/tcgdex), replayed by URL.
const FIXTURES = path.join(__dirname, '../fixtures/tcgdex');
const API = 'https://api.tcgdex.net/v2/en';
function replay(calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const file = path.join(FIXTURES, encodeURIComponent(url.replace(API, '')) + '.json');
    if (!fs.existsSync(file)) return new Response('{"status":404}', { status: 404 });
    return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
const down: Fetcher = async () => {
  throw new Error('getaddrinfo ENOTFOUND api.tcgdex.net');
};

/** Card details (src/application/catalog) over TCGdex, as these tests ask for them: a lookup, filling in a stored card, and whether a card wants one. */
class CardDetails {
  readonly database: TcgdexCardDatabase;
  private readonly now: () => Date;

  constructor(o: { fetcher: Fetcher; now?: () => Date }) {
    this.now = o.now ?? (() => new Date());
    this.database = new TcgdexCardDatabase({ fetcher: o.fetcher, clock: { now: this.now } });
  }

  async lookup(name: string, number: string, hints: { set?: string; setCode?: string } = {}) {
    const r = await new LookUpCard({ database: this.database }).execute({ name, number, ...hints });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.matches;
  }

  fill(store: Store, id: string, force = false, chosen?: string) {
    return createCardLookups({ store, database: this.database, now: this.now }).fillCard.execute({ cardId: id, force, chosen });
  }

  wants(card: Record<string, unknown> | undefined) {
    return wantsDetails(card, this.now());
  }
}

describe('looking up a card by name and number', () => {
  it('finds the one card with that name, number and set size', async () => {
    const [m, ...rest] = await new CardDetails({ fetcher: replay() }).lookup('Pikachu', '51/162');
    expect(rest).toEqual([]);
    expect(m).toEqual({
      id: 'sv05-051',
      setId: 'sv05',
      name: 'Pikachu',
      number: '051',
      set: 'Temporal Forces',
      setCode: 'TEF',
      total: 162,
      rarity: 'Common',
      artist: 'kodama',
      released: '2024-03-22',
      thumb: 'https://assets.tcgdex.net/en/sv/sv05/051/low.webp',
    });
  });

  it('offers every match when the number alone is ambiguous, and narrows by a typed set code or set', async () => {
    const d = new CardDetails({ fetcher: replay() });
    expect((await d.lookup('Pikachu', '51')).map((m) => m.setCode).sort()).toEqual(['30C', 'TEF']);
    expect((await d.lookup('Pikachu', '51', { setCode: 'tef' })).map((m) => m.set)).toEqual(['Temporal Forces']);
    expect((await d.lookup('Pikachu', '51', { set: 'Pokemon Temporal Forces' })).map((m) => m.setCode)).toEqual(['TEF']);
    // A set code that doesn't match anything doesn't hide the matches.
    expect(await d.lookup('Pikachu', '51', { setCode: 'XYZ' })).toHaveLength(2);
  });

  it('matches names however they are written', async () => {
    const d = new CardDetails({ fetcher: replay() });
    expect((await d.lookup('Meowth EX', '62/88'))[0]).toMatchObject({ setCode: 'POR', rarity: 'Double Rare', artist: '5ban Graphics' });
    expect((await d.lookup("N's Zekrom", '031'))[0]).toMatchObject({ setCode: 'MEP', total: null, rarity: 'Promo' });
    expect((await d.lookup('Hole-Digging Shovel', '74/88'))[0]).toMatchObject({ set: 'Perfect Order', artist: 'Toyste Beach' });
    expect((await d.lookup('Hisuian Zoroark V Star', 'SWSH298'))[0]).toMatchObject({ set: 'SWSH Black Star Promos', setCode: null });
    expect((await d.lookup('Charizard V', '17/172'))[0]).toMatchObject({ setCode: 'BRS', rarity: 'Ultra Rare' });
  });

  it('finds names with accents, words in brackets, or an unusual spelling (by number)', async () => {
    const d = new CardDetails({ fetcher: replay() });
    expect((await d.lookup('Pokedex', '87/102'))[0]).toMatchObject({ set: 'Base Set', setCode: 'BS', artist: 'Keiji Kinebuchi' });
    expect((await d.lookup('Pokemon Center Lady', '105/106'))[0]).toMatchObject({ setCode: 'FLF', rarity: 'Ultra Rare' });
    expect((await d.lookup("Sleep! (Rocket's Secret Machine)", '79/82'))[0]).toMatchObject({ set: 'Team Rocket', setCode: 'RO' });
    const calls: string[] = [];
    expect((await new CardDetails({ fetcher: replay(calls) }).lookup('Poke-dex', '87/102'))[0]).toMatchObject({ id: 'base1-87' });
    expect(calls.some((u) => u.endsWith('/cards?localId=87'))).toBe(true);
  });

  it('finds nothing for a card TCGdex does not have, or without a name or number', async () => {
    const d = new CardDetails({ fetcher: replay() });
    expect(await d.lookup('Nidorina', '101')).toEqual([]);
    expect(await d.lookup('', '51')).toEqual([]);
    expect(await d.lookup('Pikachu', '')).toEqual([]);
  });

  it("puts rarities in the ledger's words", () => {
    expect(['Double rare', 'Rare Holo', 'Holo Rare VSTAR', 'Illustration rare', 'Special illustration rare', 'ACE SPEC Rare', 'None', '', 'Amazing Rare'].map(mapRarity)).toEqual([
      'Double Rare',
      'Holo Rare',
      'Ultra Rare',
      'Illustration Rare',
      'Special Illustration Rare',
      'ACE SPEC Rare',
      null,
      null,
      'Amazing Rare',
    ]);
  });

  it('asks TCGdex once while the same card is typed again', async () => {
    const calls: string[] = [];
    const d = new CardDetails({ fetcher: replay(calls) });
    await d.lookup('Pikachu', '51/162');
    const n = calls.length;
    await d.lookup('Pikachu', '51/162');
    await d.lookup('Pikachu', '51');
    expect(calls.length).toBe(n);
  });
});

describe('filling in a stored card', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-details-'));
    store = new Store(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('fills only the empty fields and records what it did', async () => {
    store.set('cards', 'a', { name: 'Pikachu', number: '51/162', rarity: 'My own rarity' });
    expect(await new CardDetails({ fetcher: replay() }).fill(store, 'a')).toBe('filled');
    expect(store.get('cards', 'a')).toMatchObject({
      set: 'Temporal Forces',
      setCode: 'TEF',
      rarity: 'My own rarity',
      artist: 'kodama',
      released: '2024-03-22',
      details: { source: 'tcgdex', result: 'filled', id: 'sv05-051', filled: ['set', 'setCode', 'artist', 'released'], released: '2024-03-22' },
    });
  });

  it('changes nothing when several cards match or none does, and notes why', async () => {
    store.set('cards', 'a', { name: 'Pikachu', number: '51' });
    store.set('cards', 'b', { name: 'Nidorina', number: '101', setCode: 'MEP' });
    const d = new CardDetails({ fetcher: replay() });
    expect(await d.fill(store, 'a')).toBe('several');
    expect(await d.fill(store, 'b')).toBe('notFound');
    expect(store.get('cards', 'a')).toMatchObject({ name: 'Pikachu', number: '51', details: { result: 'several' } });
    expect(store.get('cards', 'a')!.set).toBeUndefined();
    expect(store.get('cards', 'b')).toMatchObject({ setCode: 'MEP', details: { result: 'notFound' } });
  });

  it('leaves alone cards that are complete, not English, missing a name or number, or looked up this week', async () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const d = new CardDetails({ fetcher: replay(), now: () => now });
    store.set('cards', 'full', { name: 'Pikachu', number: '51/162', set: 'x', setCode: 'x', rarity: 'x', artist: 'x', released: '2024-03-22' });
    store.set('cards', 'ja', { name: 'Pikachu', number: '51/162', language: 'Japanese' });
    store.set('cards', 'noname', { number: '51/162' });
    store.set('cards', 'recent', { name: 'Pikachu', number: '51', details: { source: 'tcgdex', result: 'several', v: DETAILS_VERSION, checkedAt: '2026-10-01T00:00:00Z' } });
    store.set('cards', 'old', { name: 'Pikachu', number: '51/162', details: { source: 'tcgdex', result: 'notFound', checkedAt: '2026-09-20T00:00:00Z' } });
    for (const id of ['full', 'ja', 'noname', 'recent']) expect(await d.fill(store, id)).toBe('skipped');
    expect(await d.fill(store, 'recent', true)).toBe('several');
    expect(await d.fill(store, 'old')).toBe('filled');
  });

  it('redoes a lookup from before the current checks straight away, by its TCGdex id', async () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const urls: string[] = [];
    const fetcher = replay();
    const d = new CardDetails({ fetcher: (u, i) => (urls.push(String(u)), fetcher(u, i)), now: () => now });
    const done = { set: 'Base Set', setCode: 'BS', rarity: 'Uncommon', artist: 'Keiji Kinebuchi' };
    // Looked up yesterday, before release dates: wanted anyway.
    store.set('cards', 'a', { name: 'Pokedex', number: '87/102', ...done, details: { source: 'tcgdex', result: 'filled', id: 'base1-87', checkedAt: '2026-10-02T00:00:00Z' } });
    // Looked up since: has its date, or TCGdex had none for it; either way not asked again this week.
    store.set('cards', 'b', { name: 'Pokedex', number: '87/102', ...done, released: '1999-01-09', details: { source: 'tcgdex', result: 'complete', v: DETAILS_VERSION, id: 'base1-87', released: '1999-01-09', checkedAt: '2026-10-02T00:00:00Z' } });
    store.set('cards', 'c', { name: 'Pokedex', number: '87/102', ...done, details: { source: 'tcgdex', result: 'complete', v: DETAILS_VERSION, id: 'base1-87', released: null, checkedAt: '2026-10-02T00:00:00Z' } });
    // Complete, with its date, but checked before the set it's filed under was checked: redone too.
    store.set('cards', 'd', { name: 'Pokedex', number: '87/102', ...done, released: '1999-01-09', details: { source: 'tcgdex', result: 'complete', id: 'base1-87', released: '1999-01-09', checkedAt: '2026-10-02T00:00:00Z' } });
    expect(d.wants(store.get('cards', 'a'))).toBe(true);
    expect(d.wants(store.get('cards', 'b'))).toBe(false);
    expect(d.wants(store.get('cards', 'c'))).toBe(false);
    expect(d.wants(store.get('cards', 'd'))).toBe(true);
    expect(await d.fill(store, 'd')).toBe('complete');
    expect(store.get('cards', 'd')!.details).toMatchObject({ v: DETAILS_VERSION, setId: 'base1', set: 'Base Set', setCode: 'BS', filedUnder: null });
    expect(await d.fill(store, 'a')).toBe('filled');
    expect(store.get('cards', 'a')).toMatchObject({ ...done, released: '1999-01-09', details: { result: 'filled', id: 'base1-87', filled: ['released'], released: '1999-01-09' } });
    // An automatic match from before the current checks is looked up again (it could be from
    // another set); here it's the same card.
    expect(urls.some((u) => u.includes('/cards?'))).toBe(true);
    expect(d.wants(store.get('cards', 'a'))).toBe(false);
  });

  it('finds a reprint in its set’s Classic Collection, not the card it reprints from another set', async () => {
    const d = new CardDetails({ fetcher: replay() });
    // The 30th Celebration Lugia reprints the Aquapolis one and keeps its printed number, 149/147.
    store.set('cards', 'mine', { name: 'Lugia', number: '149/147', set: '30th Celebration' });
    expect(await d.fill(store, 'mine')).toBe('filled');
    expect(store.get('cards', 'mine')).toMatchObject({ set: '30th Celebration', details: { id: '30th-c-029', setId: '30th-c', set: '30th Classic Collection', parentSet: '30th Celebration', filedUnder: null } });
    // Numbered as TCGdex numbers it in the Classic Collection: its own set first, not Unseen Forces' Lugia 29.
    store.set('cards', 'byTcgdex', { name: 'Lugia', number: '029', set: '30th Celebration' });
    expect(await d.fill(store, 'byTcgdex')).toBe('filled');
    expect(store.get('cards', 'byTcgdex')!.details).toMatchObject({ id: '30th-c-029' });
    // Filed under Aquapolis (or nowhere), the number finds the Aquapolis card as before.
    store.set('cards', 'aquapolis', { name: 'Lugia', number: '149/147', set: 'Aquapolis' });
    store.set('cards', 'bare', { name: 'Lugia', number: '149/147' });
    for (const id of ['aquapolis', 'bare']) expect(await d.fill(store, id)).toBe('filled');
    expect(store.get('cards', 'aquapolis')!.details).toMatchObject({ id: 'ecard2-149', filedUnder: null });
    expect(store.get('cards', 'bare')!.details).toMatchObject({ id: 'ecard2-149' });
  });

  it('never matches TCG Pocket’s digital cards', async () => {
    // Lugia 131 is Unbroken Bonds' and TCG Pocket's (B2-131): only the real card.
    const d = new CardDetails({ fetcher: replay() });
    expect((await d.lookup('Lugia', '131')).map((m) => m.id)).toEqual(['sm9-131']);
  });

  it('looks an older automatic match up again, replacing one from another set, but keeps what the person chose', async () => {
    const d = new CardDetails({ fetcher: replay() });
    const old = { source: 'tcgdex', result: 'filled', v: 2, id: 'ecard2-149', setId: 'ecard2', set: 'Aquapolis', checkedAt: '2026-10-01T00:00:00Z' };
    store.set('cards', 'auto', { name: 'Lugia', number: '149/147', set: '30th Celebration', details: old });
    store.set('cards', 'chose', { name: 'Lugia', number: '149/147', set: '30th Celebration', details: { ...old, chosen: true } });
    expect(d.wants(store.get('cards', 'auto'))).toBe(true);
    await d.fill(store, 'auto');
    await d.fill(store, 'chose');
    expect(store.get('cards', 'auto')!.details).toMatchObject({ v: DETAILS_VERSION, id: '30th-c-029' });
    expect(store.get('cards', 'auto')!.details).not.toHaveProperty('chosen');
    expect(store.get('cards', 'chose')!.details).toMatchObject({ v: DETAILS_VERSION, id: 'ecard2-149', chosen: true });
    // Choosing from Cards to check is remembered.
    await d.fill(store, 'auto', true, 'ecard2-149');
    expect(store.get('cards', 'auto')!.details).toMatchObject({ id: 'ecard2-149', chosen: true });
  });

  it("dates a promo by the set it's filed under, when TCGdex knows that set", async () => {
    const d = new CardDetails({ fetcher: replay() });
    store.set('cards', 'filed', { name: 'Hisuian Zoroark V Star', number: 'SWSH298', set: 'Pokemon Crown Zenith' });
    store.set('cards', 'bare', { name: 'Hisuian Zoroark V Star', number: 'SWSH298' });
    store.set('cards', 'odd', { name: 'Hisuian Zoroark V Star', number: 'SWSH298', set: 'My promos' });
    for (const id of ['filed', 'bare', 'odd']) expect(await d.fill(store, id)).toBe('filled');
    expect(store.get('cards', 'filed')).toMatchObject({ set: 'Pokemon Crown Zenith', released: '2023-01-20', details: { released: '2023-01-20' } });
    // Not filed anywhere, or under a set TCGdex doesn't have: the promo series' date.
    expect(store.get('cards', 'bare')).toMatchObject({ set: 'SWSH Black Star Promos', released: '2019-11-15' });
    expect(store.get('cards', 'odd')!.released).toBe('2019-11-15');
  });

  it('flags a card filed under a set that TCGdex knows but that its name and number are not from', async () => {
    const d = new CardDetails({ fetcher: replay() });
    store.set('cards', 'wrong', { name: 'Bill', number: '118/130', set: 'Pokemon Base Set', setCode: 'PBS' });
    store.set('cards', 'right', { name: 'Bill', number: '118/130', set: 'Base Set 2', setCode: 'PBS' });
    store.set('cards', 'ownLabel', { name: 'Bill', number: '118/130', set: 'Pokemon Base Set Two', setCode: 'PBS' });
    for (const id of ['wrong', 'right', 'ownLabel']) await d.fill(store, id);
    expect(store.get('cards', 'wrong')).toMatchObject({
      set: 'Pokemon Base Set', // never changed by itself
      released: '2000-02-24',
      details: { result: 'filled', id: 'base4-118', setId: 'base4', set: 'Base Set 2', setCode: 'B2', filedUnder: { as: 'Pokemon Base Set', id: 'base1', name: 'Base Set' } },
    });
    // The right set, or a label TCGdex doesn't know (the person's own naming): not flagged.
    expect(store.get('cards', 'right')!.details).toMatchObject({ filedUnder: null });
    expect(store.get('cards', 'ownLabel')!.details).toMatchObject({ filedUnder: null });
  });

  it('suggests the name a card not found probably has, when it agrees with the set typed', async () => {
    const d = new CardDetails({ fetcher: replay() });
    store.set('cards', 'eel', { name: 'Mega Eelktross EX', number: '61/217', set: 'Ascended Heroes', setCode: 'ASC' });
    store.set('cards', 'elsewhere', { name: 'Mega Eelktross EX', number: '61/99', setCode: 'XYZ' });
    expect(await d.fill(store, 'eel')).toBe('notFound');
    expect(store.get('cards', 'eel')!.details).toMatchObject({
      result: 'notFound',
      v: DETAILS_VERSION,
      suggest: [{ id: 'me02.5-061', name: 'Mega Eelektross ex', set: 'Ascended Heroes', setCode: 'ASC', number: '061', total: 217 }],
    });
    expect(await d.fill(store, 'elsewhere')).toBe('notFound');
    expect(store.get('cards', 'elsewhere')!.details).toMatchObject({ suggest: null });
    expect(similarity('Mega Eelktross EX', 'Mega Eelektross ex')).toBeGreaterThan(0.9);
    expect(similarity('Nidorina', 'Pikachu')).toBeLessThan(0.5);
  });

  it('keeps the choices when several cards match, and uses the one chosen', async () => {
    const d = new CardDetails({ fetcher: replay() });
    store.set('cards', 'a', { name: 'Pikachu', number: '51', rarity: 'Mine' });
    expect(await d.fill(store, 'a')).toBe('several');
    const options = (store.get('cards', 'a')!.details as { options: { id: string; setCode: string }[] }).options;
    expect(options.map((o) => o.setCode).sort()).toEqual(['30C', 'TEF']);
    expect(await d.fill(store, 'a', true, 'sv05-051')).toBe('filled');
    expect(store.get('cards', 'a')).toMatchObject({ set: 'Temporal Forces', setCode: 'TEF', rarity: 'Mine', released: '2024-03-22', details: { result: 'filled', id: 'sv05-051' } });
  });

  it('keeps the match the person chose when a lookup fails, and uses it next time', async () => {
    // Pikachu 51 is in two sets; the person chose Temporal Forces'. Its rarity is still blank.
    const chosen = { source: 'tcgdex', result: 'filled', v: DETAILS_VERSION, id: 'sv05-051', setId: 'sv05', set: 'Temporal Forces', setCode: 'TEF', chosen: true, checkedAt: '2026-10-01T00:00:00Z' };
    store.set('cards', 'a', { name: 'Pikachu', number: '51', details: chosen });
    expect(await new CardDetails({ fetcher: down }).fill(store, 'a', true)).toBe('error');
    const { checkedAt: _, result: __, ...match } = chosen;
    expect(store.get('cards', 'a')!.details).toEqual({ ...match, result: 'error', error: expect.stringContaining('ENOTFOUND'), checkedAt: expect.any(String) });
    // TCGdex is back: the chosen card is fetched by its id, not offered as one of several again.
    const calls: string[] = [];
    expect(await new CardDetails({ fetcher: replay(calls) }).fill(store, 'a', true)).not.toBe('several');
    expect(store.get('cards', 'a')!.details).toMatchObject({ id: 'sv05-051', chosen: true });
    expect(calls.some((u) => u.includes('/cards/sv05-051'))).toBe(true);
  });

  it('searches again when TCGdex no longer has the matched card', async () => {
    const gone = { source: 'tcgdex', result: 'filled', v: DETAILS_VERSION, id: 'sv05-999', setId: 'sv05', set: 'Temporal Forces', chosen: true, checkedAt: '2026-10-01T00:00:00Z' };
    store.set('cards', 'a', { name: 'Pikachu', number: '51', details: gone });
    expect(await new CardDetails({ fetcher: replay() }).fill(store, 'a', true)).toBe('error');
    const details = store.get('cards', 'a')!.details as Record<string, unknown>;
    expect(details).toMatchObject({ result: 'error', error: expect.stringContaining('404') });
    expect(details).not.toHaveProperty('id');
    expect(details).not.toHaveProperty('chosen');
    expect(await new CardDetails({ fetcher: replay() }).fill(store, 'a', true)).toBe('several');
  });

  it('records a failed lookup without changing the card', async () => {
    store.set('cards', 'a', { name: 'Pikachu', number: '51/162' });
    expect(await new CardDetails({ fetcher: down }).fill(store, 'a')).toBe('error');
    expect(store.get('cards', 'a')).toMatchObject({ name: 'Pikachu', details: { result: 'error', error: expect.stringContaining('ENOTFOUND') } });
  });
});

describe('lookup routes', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-lookup-'));
    store = new Store(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('looks a card up for the Add card form, and starts Fill in missing details', async () => {
    const cardLookups = createCardLookups({ store, database: new CardDetails({ fetcher: replay() }).database, delayMs: 1 });
    const app = createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public'), cardLookups });
    const r = await request(app).get('/api/cards/lookup').query({ name: 'Pikachu', number: '51' }).expect(200);
    expect(r.body.matches.map((m: { setCode: string }) => m.setCode).sort()).toEqual(['30C', 'TEF']);
    await request(app).get('/api/cards/lookup').query({ name: 'Pikachu' }).expect(400);
    store.set('cards', 'a', { name: 'Pikachu', number: '51/162' });
    expect((await request(app).post('/api/cards/fill-details').expect(202)).body).toEqual({ started: true, cards: 1 });
    await cardLookups.fillEveryCard.finished();
    expect(store.get('cards', 'a')).toMatchObject({ setCode: 'TEF' });
  });

  it('uses the TCGdex card a person chose for a card, and prices it', async () => {
    const details = new CardDetails({ fetcher: replay() });
    const updateCard = vi.fn(async () => 'updated' as const);
    const updater = { schedule: () => ({ enabled: true, hour: 5, timeZone: 'UTC' }), running: false, updateCard } as unknown as PriceUpdater;
    const app = createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public'), cardDatabase: details.database, updater });
    store.set('cards', 'a', { name: 'Pikachu', number: '51', details: { source: 'tcgdex', result: 'several', v: DETAILS_VERSION, checkedAt: new Date().toISOString() } });
    const r = await request(app).post('/api/cards/a/details').send({ id: '30th-051' }).expect(200);
    expect(r.body).toMatchObject({ result: 'filled', card: { set: '30th Celebration', setCode: '30C', details: { id: '30th-051' } } });
    expect(updateCard).toHaveBeenCalledWith('a');
    await request(app).post('/api/cards/a/details').send({ id: 'no such/id' }).expect(400);
    await request(app).post('/api/cards/gone/details').send({ id: '30th-051' }).expect(404);
  });

  it('answers 503 when lookups are turned off, and 502 when TCGdex is down', async () => {
    await request(createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public') }))
      .get('/api/cards/lookup')
      .query({ name: 'Pikachu', number: '51' })
      .expect(503);
    const app = createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../../public'), cardDatabase: new CardDetails({ fetcher: down }).database });
    const r = await request(app).get('/api/cards/lookup').query({ name: 'Pikachu', number: '51' }).expect(502);
    expect(r.body.error).toMatch(/Couldn't reach api\.tcgdex\.net/);
  });
});
