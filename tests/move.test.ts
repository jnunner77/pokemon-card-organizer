import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/move.js is a plain browser script; load it the way the page does.
type Spot = { page: number; slot: number };
type Card = { id: string; page?: number | null; slot?: number | null };
type Plan = (pockets: number | null, cards: Card[], ids: string[], at: Spot | null) => { moves: ({ id: string } & (Spot | { page: null; slot: null }))[]; shifted: number };
const sandbox = { window: {} as { BinderMove: { plan: Plan; end: (pockets: number | null, cards: Card[], ids: string[]) => Spot | null; target: (ids: string[], current: string | null, last: string | null) => string | null } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/move.js'), 'utf8'), sandbox);
const { plan, end, target } = sandbox.window.BinderMove;
const c = (id: string, page: number, slot: number) => ({ id, page, slot });

describe('moving cards to a binder', () => {
  // A 4-pocket binder: page 1 full, page 2 with a gap at #2, then #3 and nothing after.
  const binder = [c('a', 1, 1), c('b', 1, 2), c('c', 1, 3), c('d', 1, 4), c('e', 2, 1), c('f', 2, 3)];

  it('puts them after the last card by default, without filling earlier gaps', () => {
    expect(plan(4, binder, ['x'], null)).toEqual({ moves: [{ id: 'x', page: 2, slot: 4 }], shifted: 0 });
    expect(plan(4, binder, ['x', 'y'], null).moves).toEqual([{ id: 'x', page: 2, slot: 4 }, { id: 'y', page: 3, slot: 1 }]);
    expect(plan(9, [], ['x'], null).moves).toEqual([{ id: 'x', page: 1, slot: 1 }]);
    expect(end(4, binder, ['x'])).toEqual({ page: 2, slot: 4 });
  });

  it('puts one in an empty pocket without moving anything else', () => {
    expect(plan(4, binder, ['x'], { page: 2, slot: 2 })).toEqual({ moves: [{ id: 'x', page: 2, slot: 2 }], shifted: 0 });
  });

  it('shifts the cards in the way along, only up to the next empty pocket', () => {
    expect(plan(4, binder, ['x'], { page: 1, slot: 3 })).toEqual({
      moves: [{ id: 'x', page: 1, slot: 3 }, { id: 'c', page: 1, slot: 4 }, { id: 'd', page: 2, slot: 1 }, { id: 'e', page: 2, slot: 2 }],
      shifted: 3,
    });
    // Two cards in front of f: one gap past it (#4) is enough.
    expect(plan(4, binder, ['x', 'y'], { page: 2, slot: 2 })).toEqual({
      moves: [{ id: 'x', page: 2, slot: 2 }, { id: 'y', page: 2, slot: 3 }, { id: 'f', page: 2, slot: 4 }],
      shifted: 1,
    });
  });

  it('leaves the pocket a card comes from empty when it moves within its own binder', () => {
    // b moves to the end: its pocket isn't filled, and nothing else moves.
    expect(plan(4, binder, ['b'], null)).toEqual({ moves: [{ id: 'b', page: 2, slot: 4 }], shifted: 0 });
    // f is the last card: moving it to the end puts it after e's run, where the gap was.
    expect(end(4, binder, ['f'])).toEqual({ page: 2, slot: 2 });
    // a moves in front of c: b stays, c and d shift, and a's old pocket stays empty.
    expect(plan(4, binder, ['a'], { page: 1, slot: 3 }).moves).toEqual([{ id: 'a', page: 1, slot: 3 }, { id: 'c', page: 1, slot: 4 }, { id: 'd', page: 2, slot: 1 }, { id: 'e', page: 2, slot: 2 }]);
  });

  it("ignores cards with no pocket or in a pocket past the page's size", () => {
    const odd = [c('a', 1, 1), { id: 'loose', page: null, slot: null }, c('big', 1, 7)];
    expect(plan(4, odd, ['x'], null).moves).toEqual([{ id: 'x', page: 1, slot: 2 }]);
  });

  it('puts cards in a display case with no page or pocket, moving nothing else', () => {
    const inCase = [{ id: 'a', page: null, slot: null }, { id: 'b', page: null, slot: null }];
    expect(plan(null, inCase, ['x', 'y'], null)).toEqual({ moves: [{ id: 'x', page: null, slot: null }, { id: 'y', page: null, slot: null }], shifted: 0 });
    expect(plan(null, inCase, ['x'], { page: 1, slot: 1 }).moves).toEqual([{ id: 'x', page: null, slot: null }]);
    expect(end(null, inCase, ['x'])).toBeNull();
  });

  it("starts on the binder you're in, else the one picked last time, else the first", () => {
    const ids = ['ir', 'b2', 'case'];
    expect(target(ids, 'b2', 'ir')).toBe('b2');
    expect(target(ids, 'case', null)).toBe('case');
    expect(target(ids, '__loose', 'b2')).toBe('b2');
    expect(target(ids, '__sales', 'gone')).toBe('ir');
    expect(target(ids, null, null)).toBe('ir');
    expect(target([], 'b2', 'b2')).toBe(null);
  });
});
