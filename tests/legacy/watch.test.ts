import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/watch.js is a plain browser script; load it the way the page does.
type Card = Record<string, unknown>;
type Status = { side: string; target: number; reached: boolean; gap: number | null };
interface BinderWatch {
  targets(c: Card): { buy: number | null; sell: number | null };
  onWatchlist(c: Card): boolean;
  owns(c: Card): boolean;
  active(c: Card): { buy: number | null; sell: number | null };
  isWatched(c: Card): boolean;
  status(c: Card, value: number | null): Status[];
  parsePrice(s: string): number | null;
  fromInputs(buy: string, sell: string): { watch?: { buy: number | null; sell: number | null } | null; error?: string };
  priceText(n: unknown): string;
  list(cards: Card[], valueOf: (c: Card) => number | null): Card[];
  reachedCount(cards: Card[], valueOf: (c: Card) => number | null): number;
  watchlistCard(fields: Card, buy: number, at: string): Card;
  gotIt(c: Card): Card;
}
const sandbox = { window: {} as { BinderWatch: BinderWatch } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/watch.js'), 'utf8'), sandbox);
const W = sandbox.window.BinderWatch;

describe('price watches in the page', () => {
  it('reads a card\'s watch prices, and watches selling only on cards the person has', () => {
    expect(W.targets({})).toEqual({ buy: null, sell: null });
    expect(W.targets({ watch: { buy: 5, sell: -1 } })).toEqual({ buy: 5, sell: null });
    expect(W.active({ watch: { buy: 5, sell: 20 } })).toEqual({ buy: 5, sell: 20 });
    expect(W.active({ watch: { buy: 5, sell: 20 }, placeholder: true })).toEqual({ buy: 5, sell: null });
    expect(W.active({ watch: { sell: 20 }, status: 'sold' })).toEqual({ buy: null, sell: null });
    expect(W.owns({ watchlist: true })).toBe(false);
    expect(W.isWatched({ watch: { sell: 20 }, placeholder: true })).toBe(false);
  });

  it('says whether each watch is reached, and by how much', () => {
    const c = { watch: { buy: 5, sell: 20 } };
    expect(W.status(c, 4.5)).toEqual([
      { side: 'buy', target: 5, reached: true, gap: -0.5 },
      { side: 'sell', target: 20, reached: false, gap: -15.5 },
    ]);
    expect(W.status(c, 20)[1]?.reached).toBe(true);
    expect(W.status(c, null)).toEqual([
      { side: 'buy', target: 5, reached: false, gap: null },
      { side: 'sell', target: 20, reached: false, gap: null },
    ]);
  });

  it('takes prices as people type them', () => {
    expect(W.parsePrice('5')).toBe(5);
    expect(W.parsePrice(' $4.50 ')).toBe(4.5);
    expect(W.parsePrice('4,5')).toBe(4.5);
    expect(W.parsePrice('.99')).toBe(0.99);
    expect(W.parsePrice('')).toBe(null);
    for (const bad of ['abc', '0', '-3', '1.234', '5$']) expect(W.parsePrice(bad)).toBeNaN();
    expect(W.fromInputs('5', '')).toEqual({ watch: { buy: 5, sell: null } });
    expect(W.fromInputs('', '')).toEqual({ watch: null });
    expect(W.fromInputs('x', '').error).toMatch(/buy price/);
    expect(W.fromInputs('', 'x').error).toMatch(/sell price/);
    expect(W.priceText(5)).toBe('5.00');
    expect(W.priceText(null)).toBe('');
  });

  it('lists watched cards and the watchlist, reached first, then the closest to their price', () => {
    const value = (c: Card) => (typeof c['v'] === 'number' ? c['v'] : null);
    const cards = [
      { name: 'Far', watch: { buy: 5 }, v: 50 },
      { name: 'Close', watch: { buy: 5 }, v: 5.5 },
      { name: 'Hit', watch: { sell: 10 }, v: 12 },
      { name: 'Not watched', v: 1 },
      { name: 'Only on the watchlist', watchlist: true, placeholder: true, v: 3 },
    ];
    expect(W.list(cards, value).map((c) => c['name'])).toEqual(['Hit', 'Close', 'Far', 'Only on the watchlist']);
    expect(W.reachedCount(cards, value)).toBe(1);
  });

  it('makes a watchlist card from Any card, and makes it the person\'s once they get it', () => {
    const c = W.watchlistCard({ name: 'Umbreon', set: 'Evolving Skies', number: '215/203' }, 5, '2026-10-25T00:00:00.000Z');
    expect(c).toMatchObject({ name: 'Umbreon', watchlist: true, placeholder: true, binderId: null, watch: { buy: 5, sell: null }, prices: [] });
    expect(W.gotIt(c)).toEqual({ watchlist: false, placeholder: false, watch: null });
    expect(W.gotIt({ ...c, watch: { buy: 5, sell: 30 } })).toEqual({ watchlist: false, placeholder: false, watch: { buy: null, sell: 30 } });
  });
});
