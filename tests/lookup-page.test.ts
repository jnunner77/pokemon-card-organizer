import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/lookup.js is a plain browser script; load it the way the page does.
interface Card { name: string; set: string; setCode: string | null; number: string; total: number | null; rarity: string | null; artist: string | null }
interface Printing { variant: string; price: { cad: number } | null }
const sandbox = {
  window: {} as {
    BinderLookup: { cardNo: (c: Partial<Card>) => string; firstPrinting: (p: (Printing | null)[] | null) => number; draftFields: (c: Partial<Card>, p?: Printing) => Record<string, string> };
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/lookup.js'), 'utf8'), sandbox);
const { cardNo, firstPrinting, draftFields } = sandbox.window.BinderLookup;

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
});
