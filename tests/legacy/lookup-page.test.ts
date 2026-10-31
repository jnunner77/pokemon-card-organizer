import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/lookup.js is a plain browser script; load it the way the page does.
interface Card { name: string; set: string; setCode: string | null; number: string; total: number | null; rarity: string | null; artist: string | null }
interface Printing { variant: string; price: { cad: number } | null }
const sandbox = {
  window: {} as {
    BinderLookup: { cardNo: (c: Partial<Card>) => string; firstPrinting: (p: (Printing | null)[] | null) => number; printingAfterPrices: (p: (Printing | null)[] | null, pi: number, picked: boolean) => number; draftFields: (c: Partial<Card>, p?: Printing) => Record<string, string>; addTarget: (binders: { id: string }[], openId: string | null, overlayOpen: boolean) => { id: string } | null; binderCard: (c: Partial<Card>, p: Printing | undefined, loc: { binderId: string; page?: number | null; slot?: number | null }, owner: string, at: string) => Record<string, unknown> };
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/lookup.js'), 'utf8'), sandbox);
const { cardNo, firstPrinting, printingAfterPrices, draftFields, binderCard, addTarget } = sandbox.window.BinderLookup;

const charizard: Card = { name: 'Charizard', set: 'Base Set', setCode: 'BS', number: '4', total: 102, rarity: 'Rare', artist: 'Mitsuhiro Arita' };

describe('a card from the card database, on the page', () => {
  it('writes its number with the set size, as printed', () => {
    expect(cardNo(charizard)).toBe('4/102');
    expect(cardNo({ number: '006', total: 165 })).toBe('006/165');
    expect(cardNo({ number: 'SWSH050', total: 307 })).toBe('SWSH050');
    expect(cardNo({ number: '12', total: null })).toBe('12');
  });

  it('shows the first priced printing first', () => {
    const p = (cad: number | null): Printing => ({ variant: '', price: cad == null ? null : { cad } });
    expect(firstPrinting([p(5), p(9)])).toBe(0);
    expect(firstPrinting([p(null), p(9)])).toBe(1);
    expect(firstPrinting([p(null), p(null)])).toBe(0);
    expect(firstPrinting([])).toBe(0);
    expect(firstPrinting(null)).toBe(0);
  });

  it('keeps a printing picked before prices arrived, and otherwise shows the first priced one', () => {
    const p = (cad: number | null): Printing => ({ variant: '', price: cad == null ? null : { cad } });
    const list = [p(null), p(null), p(9)];
    expect(printingAfterPrices(list, 1, true)).toBe(1);
    expect(printingAfterPrices(list, 1, false)).toBe(2);
    expect(printingAfterPrices(list, 5, true)).toBe(2);
    expect(printingAfterPrices(list, -1, true)).toBe(2);
    expect(printingAfterPrices([p(null), p(null)], 0, false)).toBe(0);
    expect(printingAfterPrices(null, 0, false)).toBe(0);
  });

  it('fills in a new card as the printing chosen', () => {
    expect(draftFields(charizard, { variant: '1st Edition Shadowless Holo', price: null })).toEqual({
      name: 'Charizard',
      set: 'Base Set',
      setCode: 'BS',
      number: '4/102',
      rarity: 'Rare',
      variant: '1st Edition Shadowless Holo',
      artist: 'Mitsuhiro Arita',
    });
    expect(draftFields({ ...charizard, setCode: null, rarity: null, artist: null })).toMatchObject({ setCode: '', rarity: '', artist: '', variant: '' });
  });

  it('builds the card Add to <binder> saves, as the new card form would', () => {
    const at = '2026-01-02T03:04:05.000Z';
    expect(binderCard(charizard, { variant: '1st Edition', price: null }, { binderId: 'b1', page: 3, slot: 4 }, 'Justin', at)).toEqual({
      name: 'Charizard', set: 'Base Set', setCode: 'BS', number: '4/102', rarity: 'Rare', variant: '1st Edition', artist: 'Mitsuhiro Arita',
      language: 'English', condition: 'Near Mint', grader: 'Raw', grade: '', notes: '',
      status: 'binder', owner: 'Justin', placeholder: false, imageId: null, prices: [],
      binderId: 'b1', page: 3, slot: 4, createdAt: at, updatedAt: at,
    });
  });

  it('gives a display case, or a spot with no page or pocket, none', () => {
    const at = '2026-01-02T03:04:05.000Z';
    expect(binderCard(charizard, undefined, { binderId: 'c1', page: null, slot: null }, 'Sam', at)).toMatchObject({ binderId: 'c1', page: null, slot: null, owner: 'Sam' });
    expect(binderCard(charizard, undefined, { binderId: 'c1' }, 'Sam', at)).toMatchObject({ page: null, slot: null });
  });

  it('has no variant when no printing is chosen', () => {
    expect(binderCard(charizard, undefined, { binderId: 'b1', page: 1, slot: 1 }, 'Justin', '').variant).toBe('');
  });
});

describe('which binder Add to <binder> puts the card in', () => {
  const binders = [{ id: 'b1', kind: 'binder' }, { id: 'c1', kind: 'case' }];
  it('is the binder or display case that is open', () => {
    expect(addTarget(binders, 'b1', false)).toBe(binders[0]);
    expect(addTarget(binders, 'c1', false)).toBe(binders[1]);
  });
  it('is none when Pricing or the Selling view is on top', () => {
    expect(addTarget(binders, 'b1', true)).toBeNull();
  });
  it('is none for Not in a binder, Sales and Watchlist, or a binder that is gone', () => {
    for (const id of ['__loose', '__sales', '__watch', 'gone', null]) expect(addTarget(binders, id, false)).toBeNull();
  });
});
