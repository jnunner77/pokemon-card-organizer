import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/sales.js is a plain browser script; load it the way the page does.
type Split = (total: number, values: (number | null)[], method: 'value' | 'even') => number[];
const sandbox = { window: {} as { BinderSales: { split: Split; remaining: (total: number, shares: (number | null)[]) => number } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sales.js'), 'utf8'), sandbox);
const { split, remaining } = sandbox.window.BinderSales;
const sum = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) * 100) / 100;

describe('splitting a bundle across its cards', () => {
  it('splits by market value, in proportion', () => {
    expect(split(18, [2, 4, 6], 'value')).toEqual([3, 6, 9]);
    expect(split(18, [10, 10, 20], 'value')).toEqual([4.5, 4.5, 9]);
  });

  it('splits evenly, with the leftover cents going one each to the first cards', () => {
    expect(split(18, [1, 50, 3], 'even')).toEqual([6, 6, 6]);
    expect(split(10, [null, null, null], 'even')).toEqual([3.34, 3.33, 3.33]);
    expect(split(0.05, [1, 1, 1], 'even')).toEqual([0.02, 0.02, 0.01]);
  });

  it('always adds up to the total to the cent', () => {
    for (const total of [18, 17.99, 0.01, 1000, 33.33]) {
      for (const values of [[1.07, 2.13, 0.33], [3, null, 9.99, 0.5], [0.01, 250]]) {
        expect(sum(split(total, values, 'value'))).toBe(total);
        expect(sum(split(total, values, 'even'))).toBe(total);
      }
    }
  });

  it('counts a card without a market value as the average of the others, and splits evenly when none has one', () => {
    expect(split(18, [4, null, 8], 'value')).toEqual([4, 6, 8]);
    expect(split(18, [null, null, null], 'value')).toEqual([6, 6, 6]);
    expect(split(18, [0, 0], 'value')).toEqual([9, 9]);
  });

  it("says what's left to place when shares are set by hand", () => {
    expect(remaining(18, [5, 5, 5])).toBe(3);
    expect(remaining(18, [10, 10])).toBe(-2);
    expect(remaining(17.99, [5.99, 6, 6])).toBe(0);
    expect(remaining(18, [5, null])).toBe(13);
  });
});
