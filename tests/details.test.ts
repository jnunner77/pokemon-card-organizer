import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { Autofill } from '../server/autofill';
import { CardDetails, mapRarity } from '../server/details';
import type { PriceUpdater } from '../server/pricing/updater';
import { type Fetcher, retryPolicy } from '../server/pricing/sources';
import { Store } from '../server/store';

retryPolicy.baseMs = 1;

// Real TCGdex responses recorded for these cards (tests/fixtures/tcgdex), replayed by URL.
const FIXTURES = path.join(__dirname, 'fixtures/tcgdex');
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

describe('looking up a card by name and number', () => {
  it('finds the one card with that name, number and set size', async () => {
    const [m, ...rest] = await new CardDetails({ fetcher: replay() }).lookup('Pikachu', '51/162');
    expect(rest).toEqual([]);
    expect(m).toEqual({
      id: 'sv05-051',
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
    store.set('cards', 'recent', { name: 'Pikachu', number: '51', details: { source: 'tcgdex', result: 'several', checkedAt: '2026-10-01T00:00:00Z' } });
    store.set('cards', 'old', { name: 'Pikachu', number: '51/162', details: { source: 'tcgdex', result: 'notFound', checkedAt: '2026-09-20T00:00:00Z' } });
    for (const id of ['full', 'ja', 'noname', 'recent']) expect(await d.fill(store, id)).toBe('skipped');
    expect(await d.fill(store, 'recent', true)).toBe('several');
    expect(await d.fill(store, 'old')).toBe('filled');
  });

  it('gets the release date of a card matched before release dates were kept by its TCGdex id, straight away', async () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const urls: string[] = [];
    const fetcher = replay();
    const d = new CardDetails({ fetcher: (u, i) => (urls.push(String(u)), fetcher(u, i)), now: () => now });
    const done = { set: 'Base Set', setCode: 'BS', rarity: 'Uncommon', artist: 'Keiji Kinebuchi' };
    // Looked up yesterday, before release dates: wanted anyway, and fetched by id, not searched.
    store.set('cards', 'a', { name: 'Pokedex', number: '87/102', ...done, details: { source: 'tcgdex', result: 'filled', id: 'base1-87', checkedAt: '2026-10-02T00:00:00Z' } });
    // Looked up since: has its date, or TCGdex had none for it; either way not asked again this week.
    store.set('cards', 'b', { name: 'Pokedex', number: '87/102', ...done, released: '1999-01-09', details: { source: 'tcgdex', result: 'complete', id: 'base1-87', released: '1999-01-09', checkedAt: '2026-10-02T00:00:00Z' } });
    store.set('cards', 'c', { name: 'Pokedex', number: '87/102', ...done, details: { source: 'tcgdex', result: 'complete', id: 'base1-87', released: null, checkedAt: '2026-10-02T00:00:00Z' } });
    expect(d.wants(store.get('cards', 'a'))).toBe(true);
    expect(d.wants(store.get('cards', 'b'))).toBe(false);
    expect(d.wants(store.get('cards', 'c'))).toBe(false);
    expect(await d.fill(store, 'a')).toBe('filled');
    expect(store.get('cards', 'a')).toMatchObject({ ...done, released: '1999-01-09', details: { result: 'filled', id: 'base1-87', filled: ['released'], released: '1999-01-09' } });
    expect(urls.some((u) => u.includes('/cards?'))).toBe(false);
    expect(d.wants(store.get('cards', 'a'))).toBe(false);
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

  it('records a failed lookup without changing the card', async () => {
    store.set('cards', 'a', { name: 'Pikachu', number: '51/162' });
    expect(await new CardDetails({ fetcher: down }).fill(store, 'a')).toBe('error');
    expect(store.get('cards', 'a')).toMatchObject({ name: 'Pikachu', details: { result: 'error', error: expect.stringContaining('ENOTFOUND') } });
  });
});

describe('new cards fill themselves in', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-autofill-'));
    store = new Store(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeUpdater = (o: { enabled?: boolean; running?: boolean } = {}) => {
    const updateCard = vi.fn(async (id: string) => {
      store.update('cards', id, { pricing: { source: 'pricecharting', id: '/game/x/y' } });
      return 'updated' as const;
    });
    return { updater: { schedule: () => ({ enabled: o.enabled ?? true, hour: 5, timeZone: 'UTC' }), running: o.running ?? false, updateCard } as unknown as PriceUpdater, updateCard };
  };

  it('looks up the details, then the price and picture, of each new card', async () => {
    store.set('cards', 'old', { name: 'Pikachu', number: '51/162' });
    const { updater, updateCard } = fakeUpdater();
    const a = new Autofill({ store, details: new CardDetails({ fetcher: replay() }), updater, delayMs: 1 });
    a.start();
    store.set('cards', 'new1', { name: 'Meowth EX', number: '62/88', binderId: 'b', page: 1, slot: 1 });
    store.set('cards', 'new2', { name: 'Nidorina', number: '101' });
    store.update('cards', 'old', { notes: 'edited' }); // an existing card being edited isn't new
    await a.idle();
    expect(updateCard.mock.calls.map((c) => c[0])).toEqual(['new1', 'new2']);
    expect(store.get('cards', 'new1')).toMatchObject({ set: 'Perfect Order', setCode: 'POR', rarity: 'Double Rare', artist: '5ban Graphics', pricing: { source: 'pricecharting' } });
    expect(store.get('cards', 'new2')).toMatchObject({ details: { result: 'notFound' }, pricing: { source: 'pricecharting' } });
    expect(store.get('cards', 'old')!.details).toBeUndefined();
    a.stop();
  });

  it('fills in a card that a CSV row replaced (same id, different name and number)', async () => {
    // Matched once (to another card, standing in for Bill), with that card's release date.
    store.set('cards', 'pocket', { name: 'Bill', number: '118/130', set: 'Base Set', setCode: 'PBS', binderId: 'b', page: 1, slot: 1, released: '1999-01-09', details: { source: 'tcgdex', result: 'complete', id: 'base1-87', released: '1999-01-09', checkedAt: new Date().toISOString() } });
    const { updater, updateCard } = fakeUpdater();
    const a = new Autofill({ store, details: new CardDetails({ fetcher: replay() }), updater, delayMs: 1 });
    a.start();
    // What the CSV import writes: the whole card, under the pocket's card id (here keeping the old
    // match, as an edit in the drawer would).
    store.set('cards', 'pocket', { name: 'Charizard V', number: '17/172', binderId: 'b', page: 1, slot: 1, details: { source: 'tcgdex', result: 'complete', id: 'base1-87', released: '1999-01-09', checkedAt: new Date().toISOString() } });
    await a.idle();
    expect(updateCard.mock.calls.map((c) => c[0])).toEqual(['pocket']);
    expect(store.get('cards', 'pocket')).toMatchObject({ set: 'Brilliant Stars', setCode: 'BRS', rarity: 'Ultra Rare', artist: 'N-DESIGN Inc.', released: '2022-02-25', details: { id: 'swsh9-017' } });
    a.stop();
  });

  it("redoes an automatic match when a card's name or number is edited, and keeps one the person chose", async () => {
    const recent = new Date().toISOString();
    store.set('cards', 'auto', { name: 'Pikachu', number: '51', setCode: 'XYZ', pricing: { source: 'pricecharting', id: '/old', linkedBy: 'auto' }, officialImageId: 'old', details: { source: 'tcgdex', result: 'several', checkedAt: recent } });
    store.set('cards', 'mine', { name: 'Pikachu', number: '51', pricing: { source: 'tcgplayer', id: '9', linkedBy: 'user' }, officialImageId: 'img' });
    const { updater, updateCard } = fakeUpdater();
    const seen: Record<string, unknown> = {};
    updateCard.mockImplementation(async (id: string) => {
      seen[id] = store.get('cards', id)!.pricing ?? null;
      return 'updated' as const;
    });
    const a = new Autofill({ store, details: new CardDetails({ fetcher: replay() }), updater, delayMs: 1 });
    a.start();
    store.update('cards', 'auto', { number: '51/162' });
    store.update('cards', 'mine', { number: '51/162' });
    store.update('cards', 'mine', { notes: 'only the notes changed' });
    await a.idle();
    expect(seen).toEqual({ auto: null, mine: { source: 'tcgplayer', id: '9', linkedBy: 'user' } });
    // Looked up again despite this week's lookup, because it's a different card now.
    expect(store.get('cards', 'auto')).toMatchObject({ set: 'Temporal Forces', artist: 'kodama', setCode: 'XYZ', officialImageId: null, details: { result: 'filled' } });
    expect(store.get('cards', 'mine')!.officialImageId).toBe('img');
    expect(updateCard).toHaveBeenCalledTimes(2);
    a.stop();
  });

  it('fills details only when automatic prices are off, and leaves pricing to a daily run in progress', async () => {
    for (const o of [{ enabled: false }, { running: true }]) {
      const { updater, updateCard } = fakeUpdater(o);
      const a = new Autofill({ store, details: new CardDetails({ fetcher: replay() }), updater, delayMs: 1 });
      a.start();
      const id = `c${o.enabled === false ? 1 : 2}`;
      store.set('cards', id, { name: 'Pikachu', number: '51/162' });
      await a.idle();
      expect(updateCard).not.toHaveBeenCalled();
      expect(store.get('cards', id)).toMatchObject({ setCode: 'TEF' });
      a.stop();
    }
  });

  it("doesn't treat a restored ledger as new cards", async () => {
    const { updater, updateCard } = fakeUpdater();
    const a = new Autofill({ store, details: new CardDetails({ fetcher: replay() }), updater, delayMs: 1 });
    a.start();
    store.replaceAll({ binders: {}, cards: { r1: { name: 'Pikachu', number: '51/162' } }, settings: {} });
    store.update('cards', 'r1', { notes: 'x' });
    await a.idle();
    expect(updateCard).not.toHaveBeenCalled();
    a.stop();
  });

  it('backfills release dates by itself after starting, only when cards still need them', async () => {
    const done = { set: 'Base Set', setCode: 'BS', rarity: 'Uncommon', artist: 'Keiji Kinebuchi' };
    store.set('cards', 'a', { name: 'Pokedex', number: '87/102', ...done, details: { source: 'tcgdex', result: 'complete', id: 'base1-87', checkedAt: new Date().toISOString() } });
    // Typed in full before details were filled in, so never looked up.
    store.set('cards', 'b', { name: 'Charizard V', number: '17/172', set: 'Brilliant Stars', setCode: 'BRS', rarity: 'Ultra Rare', artist: 'N-DESIGN Inc.' });
    // Looked up this week without a match: left to the weekly retry.
    store.set('cards', 'c', { name: 'Pikachu', number: '51', details: { source: 'tcgdex', result: 'several', checkedAt: new Date().toISOString() } });
    const a = new Autofill({ store, details: new CardDetails({ fetcher: replay() }), delayMs: 1, backfillAfterMs: 1 });
    a.start();
    await new Promise((r) => setTimeout(r, 20));
    await a.filled();
    expect(store.get('cards', 'a')).toMatchObject({ released: '1999-01-09' });
    expect(store.get('cards', 'b')).toMatchObject({ released: '2022-02-25' });
    expect(store.get('settings', 'details')).toMatchObject({ lastRun: { cards: 2, filled: 2 } });
    expect(a.backfill()).toBe(0);
    a.stop();
  });

  it('fills in missing details for the cards already there, with progress in settings/details', async () => {
    store.set('cards', 'a', { name: 'Pikachu', number: '51/162' });
    store.set('cards', 'b', { name: 'Pikachu', number: '51' });
    store.set('cards', 'c', { name: 'Charizard V', number: '17/172', set: 'Brilliant Stars', setCode: 'BRS', rarity: 'Ultra Rare', artist: 'N-DESIGN Inc.' });
    const a = new Autofill({ store, details: new CardDetails({ fetcher: replay() }), delayMs: 1 });
    // c has everything but its release date.
    expect(a.missing().sort()).toEqual(['a', 'b', 'c']);
    expect(a.fillAll()).toBe(3);
    await a.filled();
    expect(store.get('settings', 'details')).toMatchObject({ running: false, done: 3, total: 3, lastRun: { cards: 3, filled: 2, several: 1 } });
    expect(store.get('cards', 'a')).toMatchObject({ artist: 'kodama', released: '2024-03-22' });
    expect(store.get('cards', 'c')).toMatchObject({ released: '2022-02-25', details: { filled: ['released'] } });
    expect(a.missing()).toEqual([]); // b was looked up this week
    expect(a.missing(true)).toEqual(['b']);
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
    const details = new CardDetails({ fetcher: replay() });
    const autofill = new Autofill({ store, details, delayMs: 1 });
    const app = createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../public'), details, autofill });
    const r = await request(app).get('/api/cards/lookup').query({ name: 'Pikachu', number: '51' }).expect(200);
    expect(r.body.matches.map((m: { setCode: string }) => m.setCode).sort()).toEqual(['30C', 'TEF']);
    await request(app).get('/api/cards/lookup').query({ name: 'Pikachu' }).expect(400);
    store.set('cards', 'a', { name: 'Pikachu', number: '51/162' });
    expect((await request(app).post('/api/cards/fill-details').expect(202)).body).toEqual({ started: true, cards: 1 });
    await autofill.filled();
    expect(store.get('cards', 'a')).toMatchObject({ setCode: 'TEF' });
  });

  it('answers 503 when lookups are turned off, and 502 when TCGdex is down', async () => {
    await request(createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../public') }))
      .get('/api/cards/lookup')
      .query({ name: 'Pikachu', number: '51' })
      .expect(503);
    const app = createApp({ store, assets: new Assets(dir), publicDir: path.join(__dirname, '../public'), details: new CardDetails({ fetcher: down }) });
    const r = await request(app).get('/api/cards/lookup').query({ name: 'Pikachu', number: '51' }).expect(502);
    expect(r.body.error).toMatch(/Couldn't reach api\.tcgdex\.net/);
  });
});
