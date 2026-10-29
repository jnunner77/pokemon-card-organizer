import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/stack.js is a plain browser script; load it the way the page does.
type F = Record<string, unknown>;
type C = { id: string; binderId?: string | null; page?: number | null; slot?: number | null } & F;
type Stack = { same: (a: F, b: F) => boolean; order: (a: C, b: C) => number; units: (cards: C[]) => C[][]; fits: (list: C[], card: C) => boolean; mixed: (list: C[]) => boolean };
const sandbox = { window: {} as { BinderStack: Stack } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/stack.js'), 'utf8'), sandbox);
const { same, order, units, fits, mixed } = sandbox.window.BinderStack;

// The same cases are in tests/domain/cards/identity.test.ts for the server's copy of the rule
// (src/domain/cards/identity.ts): keep the two tables identical.
const base = { name: 'Pikachu', number: '58/102', set: 'Base Set', setCode: 'BS', variant: '', language: 'English' };

const SAME: [string, F, F][] = [
  ['the very same fields', base, { ...base }],
  ['case and punctuation of the name', base, { ...base, name: 'PIKACHU!' }],
  ['accents in the name', { ...base, name: 'Pokémon Center Lady' }, { ...base, name: 'pokemon center lady' }],
  ['51 and 051/162', { ...base, number: '51' }, { ...base, number: '051/162' }],
  ['a blank set and a set', base, { ...base, set: '', setCode: '' }],
  ['a missing set and a set', base, { name: 'Pikachu', number: '58/102', language: 'English' }],
  ['set labels with and without Pokémon', { ...base, setCode: '', set: 'Pokémon Base Set' }, { ...base, setCode: '', set: 'base set' }],
  ['set codes that match, whatever the set labels say', { ...base, set: 'Base Set' }, { ...base, set: 'Base Set (Shadowless)' }],
  ['a blank language and English', base, { ...base, language: '' }],
  ['a missing language and english', { ...base, language: undefined }, { ...base, language: 'english' }],
  ['a different condition, grade, owner and status', { ...base, condition: 'NM', owner: 'Me', status: 'binder' }, { ...base, condition: 'LP', grader: 'PSA', grade: '9', owner: 'Sam', status: 'sold', placeholder: true }],
];

const DIFFERENT: [string, F, F][] = [
  ['name', base, { ...base, name: 'Raichu' }],
  ['number', base, { ...base, number: '59/102' }],
  ['set size', { ...base, number: '51/162' }, { ...base, number: '51/165' }],
  ['set label', { ...base, setCode: '', set: 'Base Set' }, { ...base, setCode: '', set: 'Jungle' }],
  ['set codes', { ...base, setCode: 'BS' }, { ...base, setCode: 'JU' }],
  ['a variant and none', { ...base, variant: 'Holo' }, base],
  ['two variants', { ...base, variant: 'Reverse Holo' }, { ...base, variant: 'Poké Ball' }],
  ['language', base, { ...base, language: 'Japanese' }],
  ['English and another language left blank', { ...base, language: '' }, { ...base, language: 'French' }],
];

describe('the same card (the page’s copy of the rule)', () => {
  for (const [what, a, b] of SAME) {
    it(`is the same card despite ${what}`, () => {
      expect(same(a, b)).toBe(true);
      expect(same(b, a)).toBe(true);
    });
  }
  for (const [what, a, b] of DIFFERENT) {
    it(`is another card when the ${what} differs`, () => {
      expect(same(a, b)).toBe(false);
      expect(same(b, a)).toBe(false);
    });
  }
});

describe('a pocket’s copies', () => {
  const p = (id: string, over: F = {}): C => ({ ...base, id, binderId: 'b1', page: 1, slot: 1, status: 'binder', createdAt: '2026-01-01T00:00:00Z', ...over });
  const ids = (list: C[]) => list.map((c) => c.id);

  it('shows the held copy first, then a real card, then the oldest, then by id', () => {
    const list = [p('d', { createdAt: '2026-03-01T00:00:00Z' }), p('c', { status: 'sold' }), p('b', { placeholder: true }), p('a2'), p('a1'), p('e', { createdAt: '2026-02-01T00:00:00Z' })];
    expect(ids(list.slice().sort(order))).toEqual(['a1', 'a2', 'e', 'd', 'b', 'c']);
    expect(ids([p('t', { status: 'traded' }), p('s')].sort(order))).toEqual(['s', 't']);
  });

  it('groups the copies of a pocket in one unit led by the top copy, in the order of the leads', () => {
    const cards = [p('a', { page: 2, slot: 2 }), p('b2', { createdAt: '2026-02-01T00:00:00Z' }), p('b1'), p('c', { page: 1, slot: 2 })];
    expect(units(cards).map(ids)).toEqual([['a'], ['b1', 'b2'], ['c']]);
    expect(units(cards)[1]?.[0]).toBe(cards[2]);
  });

  it('puts a different card of a mixed pocket, and a card with no pocket, in units of their own', () => {
    const cards = [p('x', { name: 'Raichu', createdAt: '2026-05-01T00:00:00Z' }), p('loose', { binderId: null, page: null, slot: null }), p('y'), p('z', { createdAt: '2026-02-01T00:00:00Z' }), p('w', { name: 'Eevee', createdAt: '2026-06-01T00:00:00Z' })];
    // y is the oldest (the top copy); z is its copy; x and w are other cards in the pocket.
    expect(units(cards).map(ids)).toEqual([['x'], ['loose'], ['y', 'z'], ['w']]);
  });

  it('splits a pocket whose cards match the lead but not each other (a blank set matches any set)', () => {
    const q = (id: string, set: string, at: string) => p(id, { setCode: '', set, createdAt: at });
    const cards = [q('blank', '', '2026-01-01T00:00:00Z'), q('base', 'Base Set', '2026-02-01T00:00:00Z'), q('jungle', 'Jungle', '2026-03-01T00:00:00Z')];
    expect(units(cards).map(ids)).toEqual([['blank', 'base'], ['jungle']]);
    expect(mixed(cards)).toBe(true);
    expect(mixed([cards[0]!, cards[1]!])).toBe(false);
    expect(fits([cards[1]!], cards[2]!)).toBe(false);
  });

  it('keeps the same pocket number in two binders apart', () => {
    const cards = [p('a'), p('b', { binderId: 'b2' })];
    expect(units(cards).map(ids)).toEqual([['a'], ['b']]);
  });

  it('says whether a card fits a pocket, and whether a pocket holds different cards', () => {
    expect(fits([], p('a'))).toBe(true);
    expect(fits([p('b', { condition: 'LP' })], p('a'))).toBe(true);
    expect(fits([p('a')], p('a'))).toBe(true);
    expect(fits([p('b'), p('c', { name: 'Raichu' })], p('a'))).toBe(false);
    expect(fits([p('a', { name: 'Raichu' })], p('a'))).toBe(true); // only itself there
    expect(mixed([])).toBe(false);
    expect(mixed([p('a'), p('b')])).toBe(false);
    expect(mixed([p('a'), p('b', { number: '1' })])).toBe(true);
  });
});
