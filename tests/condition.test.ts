import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/condition.js is a plain browser script; load it the way the page does.
type Card = { condition?: string; grader?: string };
type Price = { amount: number; auto?: boolean };
const sandbox = { window: {} as { BinderCondition: { factor: (c: Card) => number; adjust: (c: Card, p: Price) => number | null } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/condition.js'), 'utf8'), sandbox);
const { factor, adjust } = sandbox.window.BinderCondition;

describe("a card's condition and its value", () => {
  it('takes the upper end of each range of the near-mint price', () => {
    expect(['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'].map((condition) => factor({ condition }))).toEqual([1, 0.85, 0.6, 0.35, 0.15]);
  });

  it('counts a blank or unknown condition, and any graded card, as the full price', () => {
    expect(factor({})).toBe(1);
    expect(factor({ condition: 'Mint-ish' })).toBe(1);
    expect(factor({ condition: 'Heavily Played', grader: 'PSA' })).toBe(1);
    expect(factor({ condition: 'Heavily Played', grader: 'Raw' })).toBe(0.35);
  });

  it('adjusts automatic prices to the cent, and leaves prices the person logged alone', () => {
    expect(adjust({ condition: 'Lightly Played' }, { amount: 2.85, auto: true })).toBe(2.42);
    expect(adjust({ condition: 'Damaged' }, { amount: 100, auto: true })).toBe(15);
    expect(adjust({ condition: 'Lightly Played' }, { amount: 2.85 })).toBe(2.85);
    expect(adjust({ condition: 'Lightly Played' }, undefined as unknown as Price)).toBeNull();
  });
});
