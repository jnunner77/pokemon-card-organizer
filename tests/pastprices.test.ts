import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/pastprices.js is a plain browser script; load it the way the page does.
type Entry = { id: string; date?: string; amount: number; currency?: string; type?: string; auto?: boolean; usd?: number; where?: string; quotes?: Record<string, number>; note?: string; grade?: string };
type Past = {
  sources: (prices: Entry[]) => string[];
  keepOnly: (prices: Entry[], keep: string[]) => { prices: Entry[]; rows: { date: string; before: number; after: number | null; where: string }[]; changed: number; removed: number };
  suggested: (card: { prices?: Entry[]; pricing?: { source?: string; disagree?: object | null } }) => string[];
};
const sandbox = { window: {} as { BinderPastPrices: Past }, Object, Math, Number, Set, String };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pastprices.js'), 'utf8'), sandbox);
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

  it('takes the higher of the sources left', () => {
    const r = P.keepOnly(magikarp, ['pricecharting', 'cardmarket']);
    const e = r.prices.find((x) => x.id === '2026-10-08')!;
    expect(e).toMatchObject({ usd: 393.61, where: 'Cardmarket', quotes: { pricecharting: 102.1, cardmarket: 393.61 } });
    expect(e.note).toMatch(/^Daily update · higher of Cardmarket US\$393\.61 and PriceCharting US\$102\.10 at 1\.4000 · TCGplayer left out/);
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
