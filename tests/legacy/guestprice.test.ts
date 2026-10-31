import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/guestprice.js is a plain browser script; load it the way the page does.
type Card = Record<string, unknown>;
interface BinderGuestPrice {
  priceOf(c: Card): number | null;
  parse(s: string): number | null;
  fromInput(s: string): { guestPrice?: number | null; error?: string };
  sameText(cards: Card[]): string;
  words(n: number, price: number | null): string;
}
const sandbox = { window: {} as { BinderGuestPrice: BinderGuestPrice } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/guestprice.js'), 'utf8'), sandbox);
const G = sandbox.window.BinderGuestPrice;

describe('the price for guests in the page', () => {
  it('reads what was typed', () => {
    expect(G.fromInput('3')).toEqual({ guestPrice: 3 });
    expect(G.fromInput('$2.50')).toEqual({ guestPrice: 2.5 });
    expect(G.fromInput('4,50')).toEqual({ guestPrice: 4.5 });
    expect(G.fromInput('  ')).toEqual({ guestPrice: null });
    for (const bad of ['abc', '0', '-2', '1.234']) expect(G.fromInput(bad).error).toMatch(/amount, like 3 or 2\.50/);
    expect(G.fromInput('$').error).toMatch(/amount, like 3 or 2\.50/);
    expect(G.parse('$')).toBeNaN();
    expect(G.parse('')).toBeNull();
    expect(G.parse('x')).toBeNaN();
  });

  it('reads a card\'s price for guests', () => {
    expect(G.priceOf({ guestPrice: 3 })).toBe(3);
    for (const bad of [0, -1, null, '3', undefined]) expect(G.priceOf({ guestPrice: bad })).toBeNull();
    expect(G.priceOf({})).toBeNull();
  });

  it('prefills the price the chosen cards share', () => {
    expect(G.sameText([{ guestPrice: 3 }, { guestPrice: 3 }])).toBe('3.00');
    expect(G.sameText([{ guestPrice: 3 }, { guestPrice: 4 }])).toBe('');
    expect(G.sameText([{ guestPrice: 3 }, {}])).toBe('');
    expect(G.sameText([{}, {}])).toBe('');
  });

  it('says what was saved', () => {
    expect(G.words(12, 3)).toBe('Guests see 12 cards at $3.00');
    expect(G.words(1, 2.5)).toBe('Guests see 1 card at $2.50');
    expect(G.words(12, null)).toBe('Guests see the market value for 12 cards');
    expect(G.words(1, null)).toBe('Guests see the market value for 1 card');
  });
});
