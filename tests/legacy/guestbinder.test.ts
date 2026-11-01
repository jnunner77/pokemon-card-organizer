import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/guestbinder.js is a plain browser script; load it the way the page does.
interface Place {
  binderId: string;
  binder: string;
  color: string | null;
  kind: 'binder' | 'case';
  order: number;
  pockets: number | null;
  page: number | null;
  pocket: number | null;
}
interface Card {
  id: string;
  name: string;
  place: Place | null;
}
interface GuestBinder {
  binders(cards: Card[]): { id: string; name: string; color: string | null; kind: string; pockets: number | null; order: number; count: number }[];
  cardsIn(id: string, cards: Card[]): Card[];
  pages(id: string, cards: Card[]): number[];
  width(pockets: number, cards: Card[]): number;
  cols(n: number): number;
  cells(id: string, page: number, cards: Card[]): Card[][];
  pageNear(page: number, pages: number[]): number | null;
  placeText(p: Place | null): string;
  pageAfterClose(shown: Card | undefined, page: number): number | null;
  tileIndex(list: Card[], shown: Card | undefined): number;
}
const sandbox = { window: {} as { GuestBinder: GuestBinder } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/guestbinder.js'), 'utf8'), sandbox);
const G = sandbox.window.GuestBinder;

const place = (over: Partial<Place> = {}): Place => ({ binderId: 'b1', binder: 'Trade', color: null, kind: 'binder', order: 0, pockets: 9, page: 1, pocket: 1, ...over });
const card = (id: string, name: string, over: Partial<Place> | null = {}): Card => ({ id, name, place: over === null ? null : place(over) });

describe('the guest page binders', () => {
  it('lists binders holding cards for sale by the binder order, then name, with their counts', () => {
    const cards = [
      card('a', 'A', { binderId: 'b2', binder: 'Zed', order: 1 }),
      card('b', 'B', { binderId: 'b1', binder: 'Trade', order: 2, color: '#2F6FD8' }),
      card('c', 'C', { binderId: 'b1', binder: 'Trade', order: 2, page: 2 }),
      card('d', 'D', { binderId: 'b3', binder: 'Alpha', order: 1 }),
      card('e', 'E', { binderId: 'case', binder: 'Showcase', kind: 'case', order: 3, pockets: null, page: null, pocket: null }),
      card('f', 'F', null),
      card('g', 'G', { binderId: 'b4', binder: 'Unplaced', page: null, pocket: null }),
    ];
    expect(G.binders(cards).map((b) => [b.id, b.name, b.count])).toEqual([['b3', 'Alpha', 1], ['b2', 'Zed', 1], ['b1', 'Trade', 2], ['case', 'Showcase', 1]]);
    expect(G.binders(cards)[2]).toMatchObject({ color: '#2F6FD8', kind: 'binder', pockets: 9 });
    expect(G.binders([])).toEqual([]);
  });

  it("puts a binder's cards in page and pocket order, then name", () => {
    const cards = [card('a', 'B', { page: 2, pocket: 1 }), card('b', 'Z', { pocket: 5 }), card('c', 'A', { pocket: 5 }), card('d', 'Q', { binderId: 'other' }), card('e', 'N', null)];
    expect(G.cardsIn('b1', cards).map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });

  it('lists the pages that hold a card', () => {
    const cards = [card('a', 'A', { page: 3 }), card('b', 'B', { page: 1 }), card('c', 'C', { page: 3, pocket: 2 }), card('d', 'D', { binderId: 'other', page: 7 })];
    expect(G.pages('b1', cards)).toEqual([1, 3]);
  });

  it('is as wide as the binder, or the pockets in use need', () => {
    expect(G.width(9, [card('a', 'A')])).toBe(9);
    expect(G.width(9, [card('a', 'A', { pocket: 11 })])).toBe(12);
    expect(G.width(4, [])).toBe(4);
    expect(G.width(9, [card('a', 'A', { pocket: 20 })])).toBe(20);
  });

  it('puts pockets in columns', () => {
    expect([4, 9, 12, 16].map(G.cols)).toEqual([2, 3, 4, 4]);
    expect(G.cols(20)).toBe(5);
  });

  it("makes a page's pockets, with copies stacked and the rest empty", () => {
    const cards = [card('a', 'Pika', { pocket: 2 }), card('b', 'Pika', { pocket: 2 }), card('c', 'Mew', { pocket: 9 }), card('d', 'Else', { page: 2, pocket: 1 })];
    const cells = G.cells('b1', 1, cards);
    expect(cells.length).toBe(9);
    expect(cells.map((c) => c.map((x) => x.id))).toEqual([[], ['a', 'b'], [], [], [], [], [], [], ['c']]);
    expect(G.cells('b1', 2, cards).filter((c) => c.length).length).toBe(1);
    expect(G.cells('b1', 1, [card('x', 'X', { pocket: 11 })]).length).toBe(12);
  });

  it('keeps the page, or goes to the nearest one', () => {
    expect(G.pageNear(2, [1, 2, 5])).toBe(2);
    expect(G.pageNear(4, [1, 2, 5])).toBe(5);
    expect(G.pageNear(9, [1, 2, 5])).toBe(5);
    expect(G.pageNear(3, [1, 5])).toBe(1);
    expect(G.pageNear(1, [])).toBeNull();
  });

  it('goes back to the page of the last card shown', () => {
    expect(G.pageAfterClose(card('a', 'A', { page: 3 }), 1)).toBe(3);
    expect(G.pageAfterClose(card('a', 'A', { page: 3 }), 3)).toBeNull();
    expect(G.pageAfterClose(card('a', 'A', { kind: 'case', page: null, pocket: null }), 1)).toBeNull();
    expect(G.pageAfterClose(card('a', 'A', null), 1)).toBeNull();
    expect(G.pageAfterClose(undefined, 1)).toBeNull();
  });

  it("finds the tile a card's pocket opens", () => {
    const list = [card('a', 'Pika', { pocket: 2 }), card('b', 'Pika', { pocket: 2 }), card('c', 'Mew', { page: 2, pocket: 2 })];
    expect(G.tileIndex(list, list[1])).toBe(0);
    expect(G.tileIndex(list, list[2])).toBe(2);
    expect(G.tileIndex(list, card('x', 'X'))).toBe(-1);
    const cases = [card('a', 'A', { kind: 'case', page: null, pocket: null }), card('b', 'B', { kind: 'case', page: null, pocket: null })];
    expect(G.tileIndex(cases, cases[1])).toBe(1);
    expect(G.tileIndex(cases, undefined)).toBe(-1);
  });

  it('says where a card is', () => {
    expect(G.placeText(place({ page: 2, pocket: 3 }))).toBe('Trade · Page 2 · Pocket 3');
    expect(G.placeText(place({ binder: 'Showcase', kind: 'case', page: null, pocket: null }))).toBe('Showcase (display case)');
    expect(G.placeText(place({ page: null }))).toBe('Trade');
    expect(G.placeText(null)).toBe('');
  });
});
