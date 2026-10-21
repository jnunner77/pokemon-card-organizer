import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/layout.js is a plain browser script; load it the way the page does.
type Spot = { page: number; slot: number };
type Card = { id: string; page?: number | null; slot?: number | null };
type Layout = { places: Card[] } | null | undefined;
type Restore = (pockets: number, cards: Card[], layout: Layout) => { moves: ({ id: string } & Spot)[]; moved: number; added: number };
const sandbox = { window: {} as { BinderLayout: { restore: Restore; current: (pockets: number, cards: Card[], layout: Layout) => boolean; pageAfterResize: (page: number, from: number, to: number) => number; pageAfterSave: (page: number, from: number | null, to: number | null) => number | null } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/layout.js'), 'utf8'), sandbox);
const { restore, current, pageAfterResize, pageAfterSave } = sandbox.window.BinderLayout;
const c = (id: string, page: number | null, slot: number | null) => ({ id, page, slot });

describe("putting a binder back in its own layout", () => {
  // Saved before sorting: a gap at page 1 #2, and page 2 #3.
  const layout = { places: [c('a', 1, 1), c('b', 1, 3), c('c', 2, 3)] };
  // Then sorted (by price, say): from page 1, pocket 1, no gaps.
  const sorted = [c('c', 1, 1), c('a', 1, 2), c('b', 1, 3)];

  it('sends every card back to its saved page and pocket, gaps included', () => {
    expect(restore(4, sorted, layout)).toEqual({ moves: [c('c', 2, 3), c('a', 1, 1), c('b', 1, 3)], moved: 2, added: 0 });
    expect(current(4, sorted, layout)).toBe(false);
    expect(current(4, [c('a', 1, 1), c('b', 1, 3), c('c', 2, 3)], layout)).toBe(true);
  });

  it('puts cards added since after the last saved card, in their current order', () => {
    const r = restore(4, [...sorted, c('n2', 2, 1), c('n1', 1, 4), c('loose', null, null)], layout);
    expect(r.added).toBe(3);
    expect(r.moves.filter((m) => !['a', 'b', 'c'].includes(m.id))).toEqual([c('n2', 3, 1), c('n1', 2, 4), c('loose', 3, 2)]);
  });

  it('skips cards removed since, and saved places that no longer fit the page', () => {
    const r = restore(4, [c('a', 1, 2), c('c', 1, 1)], { places: [...layout.places, c('d', 3, 4)] });
    expect(r.moves).toEqual([c('a', 1, 1), c('c', 2, 3)]);
    // The binder now has 2 pockets a page: c's #3 no longer exists, so it follows the last saved card.
    expect(restore(2, [c('a', 1, 2), c('c', 1, 1)], layout).moves).toEqual([c('a', 1, 1), c('c', 1, 2)]);
  });

  it('never puts two cards in one pocket, even from a damaged layout', () => {
    const r = restore(4, [c('a', 1, 1), c('b', 1, 2)], { places: [c('a', 1, 1), c('b', 1, 1), c('a', 2, 2)] });
    expect(r.moves).toEqual([c('a', 1, 1), c('b', 1, 2)]);
    expect(restore(4, [c('a', 1, 2)], null).moves).toEqual([c('a', 1, 1)]);
  });
});

describe('the page shown after the pockets per page change', () => {
  it('is the page now holding the cards you were looking at', () => {
    expect(pageAfterResize(8, 4, 9)).toBe(4); // cards 29–32 are on page 4 of 9-pocket pages
    expect(pageAfterResize(2, 9, 4)).toBe(3); // cards 10–18 start on page 3 of 4-pocket pages
    expect(pageAfterResize(1, 16, 4)).toBe(1);
    expect(pageAfterResize(3, 12, 16)).toBe(2);
  });

  it('holds the first pocket of the old page, for every pair of sizes both ways', () => {
    const sizes = [4, 9, 12, 16];
    for (const from of sizes) for (const to of sizes) for (let page = 1; page <= 40; page++) {
      const first = (page - 1) * from; // the old page's first pocket, counted from 0
      const shown = pageAfterResize(page, from, to);
      expect(first >= (shown - 1) * to && first < shown * to, `${from}→${to} page ${page}`).toBe(true);
    }
  });

  it('after a round trip, holds the first card of the page in between, and is the same page where pages line up', () => {
    const sizes = [4, 9, 12, 16];
    for (const a of sizes) for (const b of sizes) for (let page = 1; page <= 40; page++) {
      const between = pageAfterResize(page, a, b), back = pageAfterResize(between, b, a);
      const first = (between - 1) * b;
      expect(first >= (back - 1) * a && first < back * a, `${a}→${b}→${a} page ${page}`).toBe(true);
      if (((page - 1) * a) % b === 0) expect(back, `${a}→${b}→${a} page ${page} lines up`).toBe(page);
    }
    expect(pageAfterResize(pageAfterResize(3, 4, 16), 16, 4)).toBe(1); // page 3 of 4 is inside 16-pocket page 1
    expect(pageAfterResize(pageAfterResize(5, 4, 16), 16, 4)).toBe(5);
    expect(pageAfterResize(pageAfterResize(2, 4, 9), 9, 4)).toBe(1);
  });

  it('when the binder settings are saved: moves the page only if the size changed, from the page before saving', () => {
    expect(pageAfterSave(8, 4, 9)).toBe(4);
    expect(pageAfterSave(2, 9, 4)).toBe(3);
    expect(pageAfterSave(8, 9, 9)).toBe(null); // renamed only
    expect(pageAfterSave(1, null, null)).toBe(null); // a display case
    expect(pageAfterSave(1, null, 9)).toBe(null); // can't happen with cards in it; nothing to follow
  });

  it('treats a missing or odd page as page 1', () => {
    expect(pageAfterResize(0, 9, 4)).toBe(1);
    expect(pageAfterResize(Number.NaN, 9, 4)).toBe(1);
  });
});
