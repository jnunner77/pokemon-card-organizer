import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/guestfilter.js is a plain browser script; load it the way the page does.
type Filters = Record<string, string>;
interface Card {
  name?: string;
  set?: string;
  setCode?: string;
  rarity?: string;
  variant?: string;
  language?: string;
  condition?: string;
  grader?: string;
  grade?: string;
  artist?: string;
  released?: string;
  value?: number | null;
}
interface Choice {
  value: string;
  label: string;
  count: number;
}
interface GuestFilter {
  EMPTY: Filters;
  count(f: Filters): number;
  match(c: Card, f: Filters): boolean;
  choices(cards: Card[], f: Filters): Record<string, Choice[]>;
  fromStore(x: unknown): Filters;
}
const sandbox = { window: {} as { GuestFilter: GuestFilter } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/guestfilter.js'), 'utf8'), sandbox);
const F = sandbox.window.GuestFilter;

const f = (over: Filters): Filters => ({ ...F.EMPTY, ...over });
const ok = (c: Card, over: Filters) => F.match(c, f(over));

describe('the guest page filters', () => {
  it('match everything when none are set', () => {
    expect(F.count(F.EMPTY)).toBe(0);
    expect(ok({}, {})).toBe(true);
    expect(ok({ name: 'Mew', set: 'Jungle', value: null }, {})).toBe(true);
  });

  it('match a set by its name, or its code when it has no name', () => {
    expect(ok({ set: 'Base Set', setCode: 'BS' }, { set: 'Base Set' })).toBe(true);
    expect(ok({ set: 'Base Set', setCode: 'BS' }, { set: 'BS' })).toBe(false);
    expect(ok({ setCode: 'BS' }, { set: 'BS' })).toBe(true);
    expect(ok({ set: 'Jungle' }, { set: 'Base Set' })).toBe(false);
  });

  it('match rarity, variant, language and illustrator exactly', () => {
    const c = { rarity: 'Rare', variant: 'Holo', language: 'English', artist: 'Ken Sugimori' };
    expect(ok(c, { rarity: 'Rare', variant: 'Holo', language: 'English', artist: 'Ken Sugimori' })).toBe(true);
    for (const k of ['rarity', 'variant', 'language', 'artist']) {
      expect(ok(c, { [k]: 'Other' })).toBe(false);
      expect(ok({}, { [k]: 'Other' })).toBe(false);
    }
    expect(ok({ rarity: 'Rare Holo' }, { rarity: 'Rare' })).toBe(false);
  });

  it('match a raw card by condition and a graded card by grader and grade', () => {
    expect(ok({ condition: 'Near Mint' }, { shape: 'Near Mint' })).toBe(true);
    expect(ok({ grader: 'PSA', grade: '10', condition: 'Near Mint' }, { shape: 'PSA 10' })).toBe(true);
    expect(ok({ grader: 'PSA', grade: '10', condition: 'Near Mint' }, { shape: 'Near Mint' })).toBe(false);
    expect(ok({ grader: 'Raw', condition: 'Played' }, { shape: 'Played' })).toBe(true);
  });

  it('match a release year range inclusively, with either end alone', () => {
    const c = { released: '1999-01-09' };
    expect(ok(c, { yFrom: '1999', yTo: '1999' })).toBe(true);
    expect(ok(c, { yFrom: '2000' })).toBe(false);
    expect(ok(c, { yTo: '1998' })).toBe(false);
    expect(ok(c, { yFrom: '1990' })).toBe(true);
    expect(ok(c, { yTo: '2005' })).toBe(true);
    expect(ok({}, { yFrom: '1990' })).toBe(false);
    expect(ok({ released: 'soon' }, { yTo: '2030' })).toBe(false);
    expect(ok({}, { yFrom: '', yTo: '' })).toBe(true);
  });

  it('match a price range inclusively, to the cent', () => {
    expect(ok({ value: 2.5 }, { pMin: '2.50', pMax: '2.50' })).toBe(true);
    expect(ok({ value: 2.49 }, { pMin: '2.5' })).toBe(false);
    expect(ok({ value: 10.01 }, { pMax: '10' })).toBe(false);
    expect(ok({ value: 0 }, { pMax: '1' })).toBe(true);
    expect(ok({ value: null }, { pMin: '1' })).toBe(false);
    expect(ok({ value: null }, { pMax: '100' })).toBe(false);
    expect(ok({}, { pMin: '1' })).toBe(false);
    expect(ok({ value: null }, { pMin: '', pMax: 'abc' })).toBe(true);
    expect(ok({ value: 5 }, { pMin: 'abc' })).toBe(true);
  });

  it('count each range as one filter', () => {
    expect(F.count(f({ yFrom: '1999', yTo: '2001' }))).toBe(1);
    expect(F.count(f({ pMin: '1', pMax: '5' }))).toBe(1);
    expect(F.count(f({ pMin: 'abc' }))).toBe(0);
    const all = { set: 'a', yFrom: '1', yTo: '2', pMin: '1', pMax: '2', rarity: 'a', variant: 'a', language: 'a', shape: 'a', artist: 'a' };
    expect(F.count(f(all))).toBe(8);
  });

  it('list the values on the cards with counts, sets newest first and years ascending', () => {
    const cards: Card[] = [
      { set: 'Base Set', released: '1999-01-09', rarity: 'Rare', condition: 'Near Mint', value: 5 },
      { set: 'Base Set', released: '1999-01-09', rarity: 'Rare', condition: 'Played' },
      { set: 'Scarlet', released: '2023-03-31', rarity: 'Common', grader: 'PSA', grade: '10' },
      { setCode: 'XX', rarity: 'Rare' },
      { set: 'Jungle', released: '1999-06-16', rarity: '' },
      { set: 'Aqua', released: '1999-06-16' },
    ];
    const c = F.choices(cards, F.EMPTY);
    expect(c.set.map((o) => [o.value, o.count])).toEqual([['Scarlet', 1], ['Aqua', 1], ['Jungle', 1], ['Base Set', 2], ['XX', 1]]);
    expect(c.rarity.map((o) => [o.value, o.count])).toEqual([['Common', 1], ['Rare', 3]]);
    expect(c.shape.map((o) => [o.value, o.count])).toEqual([['Near Mint', 1], ['Played', 1], ['PSA 10', 1]]);
    expect(c.years.map((o) => [o.value, o.count])).toEqual([['1999', 3], ['2023', 1]]);
    expect(c.variant).toEqual([]);
  });

  it('keep a picked value that is no longer on any card, with 0', () => {
    const c = F.choices([{ set: 'Jungle', released: '1999-06-16' }], f({ set: 'Gone', rarity: 'Rare', yFrom: '1990' }));
    expect(c.set.find((o) => o.value === 'Gone')).toMatchObject({ count: 0 });
    expect(c.rarity).toEqual([{ value: 'Rare', label: 'Rare', count: 0 }]);
    expect(c.years.map((o) => o.value)).toEqual(['1990', '1999']);
  });

  it('read back only known text from the tab storage', () => {
    expect(F.fromStore({ set: 'Base Set', pMin: 5, owner: 'me', rarity: 'x'.repeat(300) })).toEqual(f({ set: 'Base Set', rarity: 'x'.repeat(200) }));
    expect(F.fromStore(null)).toEqual(F.EMPTY);
    expect(F.fromStore(['set'])).toEqual(F.EMPTY);
    expect(F.fromStore('set')).toEqual(F.EMPTY);
  });

  it('has no owner filter', () => {
    expect(Object.keys(F.EMPTY).filter((k) => /owner/i.test(k))).toEqual([]);
  });
});
