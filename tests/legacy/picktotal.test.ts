import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/picktotal.js is a plain browser script; load it the way the page does.
type Card = { v?: number | null; ph?: boolean };
type Total = { sum: number; priced: number; unpriced: number; notCounted: number };
const sandbox = { window: {} as { BinderPickTotal: { total: (cards: Card[] | undefined, value: (c: Card) => number | null, counted: (c: Card) => boolean) => Total; note: (t: Total) => string } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/picktotal.js'), 'utf8'), sandbox);
const { total, note } = sandbox.window.BinderPickTotal;
const sum = (cards: Card[] | undefined) => total(cards, (c) => c.v ?? null, (c) => !c.ph);

describe("the selected cards' total value", () => {
  it('adds as cards are selected and removes as they are deselected', () => {
    const a = { v: 5 }, b = { v: 7.34 }, c = { v: 1 };
    expect(sum([a, b]).sum).toBe(12.34);
    expect(sum([b]).sum).toBe(7.34);
    expect(sum([a, b, c]).sum).toBe(13.34);
  });

  it('rounds to the cent', () => {
    expect(sum([{ v: 0.1 }, { v: 0.2 }]).sum).toBe(0.3);
    expect(sum([{ v: 19.99 }, { v: 19.99 }, { v: 19.99 }]).sum).toBe(59.97);
  });

  it('adds nothing for unpriced cards and counts them', () => {
    const t = sum([{ v: 2 }, { v: null }, {}, { v: NaN }]);
    expect(t).toEqual({ sum: 2, priced: 1, unpriced: 3, notCounted: 0 });
  });

  it("adds nothing for cards that aren't counted, even priced ones", () => {
    const t = sum([{ v: 2 }, { v: 9, ph: true }, { ph: true }]);
    expect(t).toEqual({ sum: 2, priced: 1, unpriced: 0, notCounted: 2 });
  });

  it('is all zeros for no cards', () => {
    const zero = { sum: 0, priced: 0, unpriced: 0, notCounted: 0 };
    expect(sum([])).toEqual(zero);
    expect(sum(undefined)).toEqual(zero);
  });
});

describe('the note beside the total', () => {
  it('says how many are unpriced and not counted', () => {
    const t = (unpriced: number, notCounted: number) => note({ sum: 0, priced: 0, unpriced, notCounted });
    expect(t(0, 0)).toBe('');
    expect(t(1, 0)).toBe('1 unpriced');
    expect(t(0, 2)).toBe('2 not counted');
    expect(t(1, 2)).toBe('1 unpriced · 2 not counted');
  });
});
