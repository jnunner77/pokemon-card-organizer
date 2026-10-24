import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/status.js is a plain browser script; load it the way the page does.
type Card = { id: string; status?: string; placeholder?: boolean; sale?: object | null };
type Plan = { change: string[]; same: number; placeholder: number; quickSold: number; status: string };
type Status = {
  plan: (cards: (Card | undefined)[], status: string) => Plan;
  summary: (p: Plan, saved: number) => string;
  shared: (cards: Card[]) => string;
  statusOf: (c: Card) => string;
};
const sandbox = { window: {} as { BinderStatus: Status } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/status.js'), 'utf8'), sandbox);
const { plan, summary, shared, statusOf } = sandbox.window.BinderStatus;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const inBinder: Card = { id: 'a' };
const listed: Card = { id: 'b', status: 'listed' };
const ph: Card = { id: 'c', placeholder: true };
const quickSold: Card = { id: 'd', status: 'sold', sale: { soldCAD: 20 } };
const soldByHand: Card = { id: 'e', status: 'sold' };
const grading: Card = { id: 'f', status: 'grading' };

describe('a quick status change', () => {
  it('lists cards for sale, leaving the ones already listed', () => {
    expect(plain(plan([inBinder, listed, grading], 'listed'))).toEqual({ change: ['a', 'f'], same: 1, placeholder: 0, quickSold: 0, status: 'listed' });
  });

  it("doesn't list, grade, sell or trade a placeholder, but can put it back in the binder", () => {
    for (const s of ['listed', 'grading', 'sold', 'traded']) expect(plan([ph], s).placeholder).toBe(1);
    expect(plain(plan([{ ...ph, status: 'listed' }], 'binder').change)).toEqual(['c']);
  });

  it('leaves a card sold with Quick sell alone, whatever status is chosen', () => {
    for (const s of ['binder', 'listed', 'grading', 'sold', 'traded']) expect(plan([quickSold], s)).toMatchObject({ change: [], quickSold: 1 });
  });

  it('can put a card marked sold by hand back', () => {
    expect(plain(plan([soldByHand], 'binder').change)).toEqual(['e']);
  });

  it('counts a blank status as In binder', () => {
    expect(statusOf(inBinder)).toBe('binder');
    expect(plan([inBinder], 'binder').same).toBe(1);
    expect(shared([inBinder, { id: 'x', status: 'binder' }])).toBe('binder');
    expect(shared([inBinder, listed])).toBe('');
  });

  it('skips cards that are gone', () => {
    expect(plain(plan([undefined, inBinder], 'listed').change)).toEqual(['a']);
  });

  it('says what changed and why any cards were left as they were', () => {
    expect(summary(plan([inBinder, grading], 'listed'), 2)).toBe('2 cards listed for sale');
    expect(summary(plan([inBinder], 'binder'), 0)).toBe('Nothing changed. Left as they were: 1 was already in the binder.');
    expect(summary(plan([inBinder, listed, ph, quickSold], 'listed'), 1)).toBe(
      '1 card listed for sale. Left as they were: 1 was already listed for sale; 1 is a placeholder; 1 was sold with Quick sell (undo the sale to change it).',
    );
    expect(summary(plan([grading], 'binder'), 1)).toBe('1 card back in the binder');
  });
});
