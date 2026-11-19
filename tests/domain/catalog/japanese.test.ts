import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  catalogLanguage,
  entriesOf,
  isCurrent,
  japaneseCardsOf,
  japaneseHit,
  japaneseMatch,
  japaneseMatchId,
  japanesePrintings,
  japaneseProductOf,
  japaneseSetNamed,
  japaneseSetOf,
  type JapaneseCard,
  type JapaneseEntry,
  type JapaneseSet,
  localOf,
  lookupJapanese,
  matchLanguage,
  nextRefresh,
  parseJapaneseMatchId,
  refreshPlan,
  releasedOfGroup,
  searchJapanese,
} from '#domain/catalog/japanese.ts';
import type { TcgGroup, TcgProduct } from '#domain/catalog/tcgplayer.ts';

const product = (productId: number, name: string, number: string | null, rarity?: string): TcgProduct => ({
  productId,
  groupId: 1,
  name,
  extendedData: [...(number ? [{ name: 'Number', value: number }] : []), ...(rarity ? [{ name: 'Rarity', value: rarity }] : [])],
});

const set = (groupId: number, name: string, code: string | null, released: string | null, over: Partial<JapaneseSet> = {}): JapaneseSet => ({
  groupId, name, fullName: `${code ?? 'X'}: ${name}`, code, released, modifiedOn: 'm1', fetchedAt: '2026-11-01T00:00:00.000Z', ...over,
});
const card = (productId: number, name: string, number: string, variant = '', rarity: string | null = null): JapaneseCard => ({ productId, name, variant, number, rarity });

const s151 = set(1, 'Pokemon Card 151', 'SV2a', '2023-06-16');
const sPromo = set(2, 'Pikachu Promo Pack', 'SV-P', '2024-01-01');
const sOld = set(3, 'Old Pack', null, null);
const entries: JapaneseEntry[] = [
  ...entriesOf(s151, [card(10, 'Pikachu', '025/165', '', 'Common'), card(11, 'Pikachu', '025/165', 'Poke Ball Pattern'), card(12, 'Charizard ex', '201/165'), card(13, 'Pikachu ex', '026/165')]),
  ...entriesOf(sPromo, [card(20, 'Pikachu', '001/SV-P', '', 'Promo')]),
  ...entriesOf(sOld, [card(30, 'Pikachu', '025/100')]),
];
const ids = (l: readonly JapaneseEntry[]) => l.map((e) => e.card.productId);

describe('which catalog a language is looked up in', () => {
  it('reads blank and English as English, Japanese as Japanese, and others as none', () => {
    assert.deepEqual(['', undefined, 'English', 'en'].map(catalogLanguage), ['en', 'en', 'en', 'en']);
    assert.deepEqual(['Japanese', 'JP', 'ja'].map(catalogLanguage), ['ja', 'ja', 'ja']);
    assert.equal(catalogLanguage('Korean'), null);
  });
});

describe('Japanese match ids', () => {
  it('round trip, and other ids are not Japanese', () => {
    const id = japaneseMatchId(2, 222);
    assert.equal(id, 'ja-2-222');
    assert.deepEqual(parseJapaneseMatchId(id), { groupId: 2, productId: 222 });
    assert.equal(matchLanguage(id), 'ja');
    assert.equal(japaneseProductOf(id), '222');
    for (const bad of ['ja-x-1', 'sv05-051', 'ja-1-', '', 5]) {
      assert.equal(parseJapaneseMatchId(bad), null);
      assert.equal(japaneseProductOf(bad), null);
    }
    assert.equal(matchLanguage('sv05-051'), 'en');
  });
});

describe("TCGplayer's sets and products", () => {
  it("reads a set's release date from midnight stamps only", () => {
    assert.equal(releasedOfGroup({ groupId: 1, name: 'x', publishedOn: '2023-06-16T00:00:00' }), '2023-06-16');
    assert.equal(releasedOfGroup({ groupId: 1, name: 'x', publishedOn: '2026-11-17T13:42:11.123' }), null);
    assert.equal(releasedOfGroup({ groupId: 1, name: 'x' }), null);
    assert.deepEqual(japaneseSetOf({ groupId: 7, name: 'SV2a: Pokemon Card 151', abbreviation: ' SV2a ', publishedOn: '2023-06-16T00:00:00', modifiedOn: 'mod' }, 'now'), {
      groupId: 7, name: 'Pokemon Card 151', fullName: 'SV2a: Pokemon Card 151', code: 'SV2a', released: '2023-06-16', modifiedOn: 'mod', fetchedAt: 'now',
    });
    assert.equal(japaneseSetOf({ groupId: 7, name: 'x', abbreviation: '' }, 'now').code, null);
  });

  it('keeps cards only (sealed products have no number) and splits the name, variant and number', () => {
    const cards = japaneseCardsOf([
      product(1, 'Pikachu - 025/165 (Poke Ball Pattern)', '025/165', 'Common'),
      product(2, 'Booster Box', null),
      product(3, 'Gardevoir - 408/SM-P (JP Illustration Grand Prix Winner 2019)', '408/SM-P'),
      product(1, 'Pikachu - 025/165 (Poke Ball Pattern)', '025/165'),
    ]);
    assert.deepEqual(cards, [
      { productId: 1, name: 'Pikachu', variant: 'Poke Ball Pattern', number: '025/165', rarity: 'Common' },
      { productId: 3, name: 'Gardevoir', variant: 'JP Illustration Grand Prix Winner 2019', number: '408/SM-P', rarity: null },
    ]);
  });
});

describe('refreshing the index', () => {
  const group = (groupId: number, modifiedOn: string, publishedOn = '2024-01-01T00:00:00'): TcgGroup => ({ groupId, name: `S${groupId}: Set ${groupId}`, abbreviation: `S${groupId}`, publishedOn, modifiedOn });
  const now = new Date('2026-11-18T12:00:00Z');

  it('downloads new and changed sets, newest first, and skips unchanged ones', () => {
    const stored = [set(1, 'Set 1', 'S1', null, { modifiedOn: 'a' }), set(2, 'Set 2', 'S2', null, { modifiedOn: 'b' })];
    const plan = refreshPlan(stored, [group(1, 'a'), group(2, 'changed'), group(3, 'c', '2023-01-01T00:00:00'), group(4, 'd', '2025-01-01T00:00:00')], now);
    assert.deepEqual(plan.fetch, [4, 2, 3]);
    assert.deepEqual(plan.drop, []);
    assert.deepEqual(plan.meta.map((s) => s.groupId), [1]);
  });

  it('treats a missing modifiedOn as empty, and drops sets TCGplayer no longer lists', () => {
    const stored = [set(1, 'Set 1', 'S1', null, { modifiedOn: '' }), set(9, 'Gone', null, null)];
    const plan = refreshPlan(stored, [{ groupId: 1, name: 'S1: Set 1' }], now);
    assert.deepEqual(plan, { fetch: [], drop: [9], meta: [{ ...japaneseSetOf({ groupId: 1, name: 'S1: Set 1' }, stored[0]?.fetchedAt ?? ''), modifiedOn: '' }] });
  });

  it('downloads ten of the oldest sets as a safety net', () => {
    const stored = Array.from({ length: 15 }, (_, i) => set(i + 1, `Set ${i + 1}`, null, null, { modifiedOn: 'a', fetchedAt: new Date(Date.UTC(2026, 0, 1 + (14 - i))).toISOString() }));
    const plan = refreshPlan(stored, stored.map((s) => group(s.groupId, 'a')), now);
    assert.equal(plan.fetch.length, 10);
    assert.deepEqual(plan.fetch.slice(0, 3), [15, 14, 13]);
    assert.equal(plan.meta.length, 5);
    const fresh = stored.map((s) => ({ ...s, fetchedAt: '2026-11-10T00:00:00.000Z' }));
    assert.deepEqual(refreshPlan(fresh, fresh.map((s) => group(s.groupId, 'a')), now).fetch, []);
  });

  it('refreshes at 21:00 UTC, and knows whether the index is current', () => {
    assert.equal(nextRefresh(new Date('2026-11-18T20:59:59Z')).toISOString(), '2026-11-18T21:00:00.000Z');
    assert.equal(nextRefresh(new Date('2026-11-18T21:00:00Z')).toISOString(), '2026-11-19T21:00:00.000Z');
    assert.equal(isCurrent('2026-11-18T21:05:00Z', new Date('2026-11-19T10:00:00Z')), true);
    assert.equal(isCurrent('2026-11-18T20:00:00Z', new Date('2026-11-19T10:00:00Z')), false);
    assert.equal(isCurrent('2026-11-18T20:00:00Z', new Date('2026-11-18T20:30:00Z')), true);
    assert.equal(isCurrent(null, new Date('2026-11-18T20:30:00Z')), false);
  });
});

describe('looking a Japanese card up by name and number', () => {
  it('finds the exact name and number, newest set first', () => {
    assert.deepEqual(ids(lookupJapanese(entries, 'Pikachu', '25', {})), [10, 11, 30]);
    assert.deepEqual(ids(lookupJapanese(entries, 'charizard EX', '201/165', {})), [12]);
  });

  it('leaves out a card whose set size is different, and falls back to the words of the name', () => {
    assert.deepEqual(ids(lookupJapanese(entries, 'Pikachu', '25/165', {})), [10, 11]);
    assert.deepEqual(ids(lookupJapanese(entries, 'Pikachu', '26', {})), [13]);
    assert.deepEqual(lookupJapanese(entries, 'Raichu', '25', {}), []);
  });

  it('narrows by the set and set code typed, only when that leaves something', () => {
    assert.deepEqual(ids(lookupJapanese(entries, 'Pikachu', '25', { setCode: 'sv2a' })), [10, 11]);
    assert.deepEqual(ids(lookupJapanese(entries, 'Pikachu', '25', { set: 'Old Pack' })), [30]);
    assert.deepEqual(ids(lookupJapanese(entries, 'Pikachu', '25', { set: 'No Such Set', setCode: 'ZZZ' })), [10, 11, 30]);
  });
});

describe('searching Japanese cards', () => {
  const codes = new Set(['sv2a', 'sv-p']);
  const found = (q: string) => ids(searchJapanese(entries, q, codes)?.entries ?? []);

  it('finds cards by English name alone', () => {
    assert.deepEqual(found('pikachu'), [20, 10, 11, 30, 13]);
  });

  it('narrows by a number, a number with its set size, and a set code', () => {
    assert.deepEqual(found('pikachu 025'), [10, 11, 30]);
    assert.deepEqual(found('025/165'), [10, 11]);
    assert.deepEqual(found('pikachu sv2a'), [10, 11, 13]);
    assert.deepEqual(found('sv2a 201'), [12]);
    assert.deepEqual(found('pikachu promo'), [20]);
  });

  it('ranks the exact name before names that start with it, and says when there is more', () => {
    assert.deepEqual(found('pikachu sv2a'), [10, 11, 13]);
    assert.deepEqual(found('pikachu ex'), [13]);
    assert.equal(searchJapanese(entries, '   ', codes), null);
    const many = entriesOf(s151, Array.from({ length: 60 }, (_, i) => card(100 + i, 'Eevee', `${i + 1}/165`)));
    const r = searchJapanese(many, 'eevee', codes);
    assert.equal(r?.entries.length, 48);
    assert.equal(r?.more, true);
    assert.equal(r?.entries[0]?.own, '1');
  });
});

describe('a Japanese card as a hit and a match', () => {
  const e = entries[1];
  it('shows its variant, local number and picture', () => {
    assert.ok(e);
    assert.deepEqual(japaneseHit(e), { id: 'ja-1-11', name: 'Pikachu (Poke Ball Pattern)', number: '025', total: 165, set: 'Pokemon Card 151', thumb: 'https://tcgplayer-cdn.tcgplayer.com/product/11_in_200x200.jpg' });
    assert.equal(localOf('025/165'), '025');
  });

  it('carries the set, rarity, artist and release date', () => {
    const first = entries[0];
    assert.ok(first);
    assert.deepEqual(japaneseMatch(first, 'Kimura'), {
      id: 'ja-1-10', setId: 'ja-1', name: 'Pikachu', number: '025', set: 'Pokemon Card 151', setCode: 'SV2a', total: 165, rarity: 'Common', artist: 'Kimura', released: '2023-06-16',
      thumb: 'https://tcgplayer-cdn.tcgplayer.com/product/10_in_200x200.jpg',
    });
  });

  it('names a set by its name with or without its code', () => {
    assert.deepEqual(japaneseSetNamed([s151, sPromo], 'SV2a: Pokemon Card 151'), { id: 'ja-1', name: 'Pokemon Card 151', released: '2023-06-16' });
    assert.deepEqual(japaneseSetNamed([s151], 'pokemon card 151')?.id, 'ja-1');
    assert.equal(japaneseSetNamed([s151], 'Base Set'), null);
  });
});

describe("a Japanese card's printings", () => {
  const prices = [
    { productId: 5, subTypeName: 'Reverse Holofoil', marketPrice: 3 },
    { productId: 5, subTypeName: 'Normal', marketPrice: null, midPrice: 1.5 },
    { productId: 5, subTypeName: 'Holofoil', marketPrice: 9 },
    { productId: 6, subTypeName: 'Normal', marketPrice: 1 },
  ];
  it('lists Normal, Holofoil and Reverse Holofoil in that order, with their labels and variants', () => {
    assert.deepEqual(japanesePrintings(prices, 5, ''), [
      { label: 'regular', variant: '', usd: 1.5 },
      { label: 'holo', variant: '', usd: 9 },
      { label: 'reverse holo', variant: 'Reverse Holo', usd: 3 },
    ]);
    assert.equal(japanesePrintings(prices, 5, 'Poke Ball Pattern')[2]?.variant, 'Poke Ball Pattern');
  });

  it('gives one unpriced regular printing when there are no prices', () => {
    assert.deepEqual(japanesePrintings(prices, 99, 'Master Ball'), [{ label: 'regular', variant: 'Master Ball', usd: null }]);
  });
});
