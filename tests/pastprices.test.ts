import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/pastprices.js is a plain browser script; load it the way the page does.
type Entry = { id: string; date?: string; amount: number; currency?: string; type?: string; auto?: boolean; usd?: number; where?: string; quotes?: Record<string, number>; note?: string; grade?: string };
type Past = {
  sources: (prices: Entry[]) => string[];
  keepOnly: (prices: Entry[], keep: string[], method?: object) => { prices: Entry[]; rows: { date: string; before: number; after: number | null; where: string }[]; changed: number; removed: number };
  suggested: (card: { prices?: Entry[]; pricing?: { source?: string; disagree?: object | null } }) => string[];
};
// After blend.js, as the page loads them: each day is worked out by the price method.
const sandbox = { window: {} as { BinderPastPrices: Past }, Object, Math, Number, Set, String };
vm.createContext(sandbox);
for (const f of ['blend.js', 'pastprices.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', f), 'utf8'), sandbox);
const P = sandbox.window.BinderPastPrices;

// The 30th Celebration Magikarp (a Classic Collection reprint) priced as Paldea Evolved's: from
// 10-08 TCGplayer and Cardmarket were the other card's.
const fx = 1.4;
const day = (date: string, quotes: Record<string, number>, where: string): Entry => {
  const usd = Math.max(...Object.values(quotes));
  return { id: date, date, type: 'market', currency: 'CAD', auto: true, amount: Math.round(usd * fx * 100) / 100, usd, where, quotes, note: 'Daily update' };
};
const magikarp: Entry[] = [
  { id: 'paid', date: '2026-09-01', type: 'paid', amount: 120, currency: 'CAD', where: 'Card show' },
  day('2026-10-07', { pricecharting: 101.9 }, 'PriceCharting'),
  day('2026-10-08', { pricecharting: 102.1, tcgplayer: 352.67, cardmarket: 393.61 }, 'Cardmarket'),
  day('2026-10-09', { tcgplayer: 350 }, 'TCGplayer'),
  // An older entry, from before each source's price was kept: only where it came from.
  { id: 'old', date: '2026-10-01', type: 'market', currency: 'CAD', auto: true, amount: 140, usd: 100, where: 'PriceCharting' },
];

describe('fixing past daily prices', () => {
  it('lists the sources the daily prices came from, most used first', () => {
    expect(P.sources(magikarp)).toEqual(['pricecharting', 'tcgplayer', 'cardmarket']);
    expect(P.sources([magikarp[0]])).toEqual([]);
  });

  it('works each day out again from the sources kept, removing days with none, never touching your own prices', () => {
    const r = P.keepOnly(magikarp, ['pricecharting']);
    expect(r).toMatchObject({ changed: 1, removed: 1 });
    expect(r.rows).toEqual([
      { date: '2026-10-09', before: 490, after: null, where: 'TCGplayer' },
      { date: '2026-10-08', before: 551.05, after: 142.94, where: 'PriceCharting' },
    ]);
    const byId = Object.fromEntries(r.prices.map((e) => [e.id, e]));
    expect(byId['2026-10-08']).toMatchObject({ amount: 142.94, usd: 102.1, where: 'PriceCharting', quotes: { pricecharting: 102.1 } });
    expect(byId['2026-10-08'].note).toBe('Daily update · PriceCharting US$102.10 at 1.4000 · TCGplayer and Cardmarket left out (matched to the wrong card)');
    expect(byId['2026-10-09']).toBeUndefined();
    // Unchanged: your own price, a day that only had PriceCharting, and the older PriceCharting entry.
    expect(byId.paid).toBe(magikarp[0]);
    expect(byId['2026-10-07']).toBe(magikarp[1]);
    expect(byId.old).toBe(magikarp[4]);
  });

  it('works the sources left out by the price method', () => {
    const near: Entry[] = [day('2026-10-08', { pricecharting: 100, tcgplayer: 400, cardmarket: 110 }, 'TCGplayer')];
    // Blended (the default): PriceCharting 40 and Cardmarket 20 of the 60 left.
    const b = P.keepOnly(near, ['pricecharting', 'cardmarket']).prices[0];
    expect(b).toMatchObject({ usd: 103.33, where: 'Blend', quotes: { pricecharting: 100, cardmarket: 110 } });
    expect(b.note).toBe('Daily update · blend of PriceCharting US$100.00 (67%), Cardmarket US$110.00 (33%) at 1.4000 · TCGplayer left out (matched to the wrong card)');
    // Highest: Cardmarket's, within 25% of PriceCharting's.
    expect(P.keepOnly(near, ['pricecharting', 'cardmarket'], { method: 'highest' }).prices[0]).toMatchObject({ usd: 110, where: 'Cardmarket' });
    // The Magikarp's Cardmarket price is the other card's too: more than 25% away, so PriceCharting's.
    expect(P.keepOnly(magikarp, ['pricecharting', 'cardmarket']).prices.find((x) => x.id === '2026-10-08')).toMatchObject({ usd: 102.1, where: 'PriceCharting' });
    expect(P.keepOnly(magikarp, ['pricecharting', 'tcgplayer', 'cardmarket'])).toMatchObject({ changed: 0, removed: 0 });
  });

  it('removes a graded price when PriceCharting is left out', () => {
    const graded = [{ ...day('2026-10-08', { pricecharting: 900 }, 'PriceCharting'), grade: 'PSA 10' }];
    expect(P.keepOnly(graded, ['tcgplayer'])).toMatchObject({ removed: 1, prices: [] });
  });

  it('suggests keeping the main product’s site when the card’s prices disagree', () => {
    expect(P.suggested({ prices: magikarp, pricing: { source: 'pricecharting', disagree: { sig: 'x' } } })).toEqual(['pricecharting']);
    expect(P.suggested({ prices: magikarp, pricing: { source: 'pricecharting', disagree: null } })).toEqual(['pricecharting', 'tcgplayer', 'cardmarket']);
  });
});
