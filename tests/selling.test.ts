import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/selling.js is a plain browser script; load it the way the page does.
type Sale = { soldCAD: number; cost?: number | null; profit?: number | null; date?: string; at?: string; where?: string; bundle?: { id: string } };
type Row = { card: { id: string }; sale: Sale };
type Group = { key: string; cards: number; sales: number; soldFor: number; cost: number; profit: number; margin: number | null; noCost: number; last: string };
interface Selling {
  NOWHERE: string;
  inRange: (rows: Row[], from: string, to: string, withUndated?: boolean) => Row[];
  earliest: (rows: Row[]) => string;
  salesCount: (rows: Row[]) => number;
  totals: (rows: Row[]) => { cards: number; sales: number; soldFor: number; cost: number; profit: number; margin: number | null; avg: number | null; best: Row | null; noCost: number };
  period: (from: string, to: string) => string;
  bucketOf: (date: string, per: string) => string;
  series: (rows: Row[], from: string, to: string, per?: string) => { start: string; end: string; soldFor: number; profit: number; cards: number; sales: number }[];
  groups: (rows: Row[], keyOf: (x: Row) => string) => Group[];
  KEYS: Record<'occasion' | 'where' | 'month', (x: Row) => string>;
  sortRows: <T>(rows: T[], k: string) => T[];
  matchWhere: (sale: Sale, where: string) => boolean;
}
const sandbox = { window: {} as { BinderSelling: Selling } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/selling.js'), 'utf8'), sandbox);
const S = sandbox.window.BinderSelling;

let n = 0;
const sale = (date: string, soldCAD: number, cost: number | null, extra: Partial<Sale> = {}): Row => ({
  card: { id: `c${++n}` },
  sale: { soldCAD, cost, profit: cost == null ? null : Math.round((soldCAD - cost) * 100) / 100, date, where: 'Card show', ...extra }
});

describe('sales in a date range', () => {
  const rows = [sale('2026-09-01', 10, 5), sale('2026-09-15', 20, 30), sale('2026-10-01', 5, null), sale('', 7, 2)];

  it('keeps the sales dated within it, and the undated ones only when asked (the All range)', () => {
    expect(S.inRange(rows, '2026-09-01', '2026-09-30').map(x => x.sale.soldCAD)).toEqual([10, 20]);
    expect(S.inRange(rows, '2026-09-02', '2026-10-01', true).map(x => x.sale.soldCAD)).toEqual([20, 5, 7]);
  });

  it('finds the first sale date', () => {
    expect(S.earliest(rows)).toBe('2026-09-01');
    expect(S.earliest([])).toBe('');
  });
});

describe('totals', () => {
  it('adds up what sold, and profit and margin over the cards with a cost', () => {
    const t = S.totals([sale('2026-09-01', 10, 5), sale('2026-09-02', 20, 30), sale('2026-09-03', 6, null)]);
    expect(t).toMatchObject({ cards: 3, sales: 3, soldFor: 36, cost: 35, profit: -5, avg: 12, noCost: 1 });
    expect(t.margin).toBeCloseTo(-14.29, 2);
    expect(t.best?.sale.soldCAD).toBe(20);
  });

  it('counts a bundle once as a sale, its cards each as a card', () => {
    const b = { id: 'b1' };
    const t = S.totals([sale('2026-09-01', 6, 4, { bundle: b }), sale('2026-09-01', 12, 8, { bundle: b }), sale('2026-09-02', 3, 1)]);
    expect(t).toMatchObject({ cards: 3, sales: 2, soldFor: 21, profit: 8 });
  });

  it('has no margin, average or best sale with nothing sold', () => {
    expect(S.totals([])).toMatchObject({ cards: 0, sales: 0, soldFor: 0, margin: null, avg: null, best: null });
  });
});

describe('what sold over time', () => {
  it('picks days for up to a month, weeks for up to half a year, then months', () => {
    expect(S.period('2026-09-06', '2026-10-06')).toBe('day');
    expect(S.period('2026-07-08', '2026-10-06')).toBe('week');
    expect(S.period('2025-10-06', '2026-10-06')).toBe('month');
  });

  it('starts weeks on Monday and months on the 1st', () => {
    expect(S.bucketOf('2026-10-04', 'week')).toBe('2026-09-28'); // a Sunday
    expect(S.bucketOf('2026-10-05', 'week')).toBe('2026-10-05'); // a Monday
    expect(S.bucketOf('2026-10-31', 'month')).toBe('2026-10-01');
  });

  it('has a bar for every day of the range, empty days included', () => {
    const s = S.series([sale('2026-09-02', 10, 4), sale('2026-09-02', 5, 6), sale('2026-09-04', 3, null), sale('2026-08-30', 99, 1)], '2026-09-01', '2026-09-04');
    expect(s.map(x => [x.start, x.soldFor, x.profit, x.cards])).toEqual([
      ['2026-09-01', 0, 0, 0], ['2026-09-02', 15, 5, 2], ['2026-09-03', 0, 0, 0], ['2026-09-04', 3, 0, 1]
    ]);
  });

  it('keeps the first and last week or month within the range', () => {
    const s = S.series([sale('2026-09-30', 4, 2), sale('2026-10-02', 6, 2)], '2026-09-30', '2026-10-15', 'week');
    expect(s.map(x => [x.start, x.end, x.soldFor])).toEqual([['2026-09-30', '2026-10-04', 10], ['2026-10-05', '2026-10-11', 0], ['2026-10-12', '2026-10-15', 0]]);
    const m = S.series([sale('2025-12-31', 4, 2), sale('2026-01-01', 1, 2)], '2025-12-15', '2026-02-02', 'month');
    expect(m.map(x => [x.start, x.end, x.soldFor])).toEqual([['2025-12-15', '2025-12-31', 4], ['2026-01-01', '2026-01-31', 1], ['2026-02-01', '2026-02-02', 0]]);
  });
});

describe('sales added up', () => {
  const rows = [
    sale('2026-09-14', 10, 5, { where: 'Card show' }),
    sale('2026-09-14', 30, 20, { where: 'Card show ' }),
    sale('2026-09-20', 8, 10, { where: 'eBay' }),
    sale('2026-10-01', 12, null, { where: 'Card show' }),
    sale('2026-10-02', 4, 1, { where: '' })
  ];

  it('by occasion: where and when', () => {
    const g = S.groups(rows, S.KEYS.occasion);
    expect(g.map(x => [x.key, x.cards, x.soldFor, x.profit])).toEqual([
      ['2026-09-14|Card show', 2, 40, 15], ['2026-09-20|eBay', 1, 8, -2], ['2026-10-01|Card show', 1, 12, 0], ['2026-10-02|Not recorded', 1, 4, 3]
    ]);
    expect(g[2].noCost).toBe(1);
  });

  it('by where, with the latest sale', () => {
    const g = S.groups(rows, S.KEYS.where);
    expect(g.map(x => [x.key, x.cards, x.soldFor, x.last])).toEqual([['Card show', 3, 52, '2026-10-01'], ['eBay', 1, 8, '2026-09-20'], [S.NOWHERE, 1, 4, '2026-10-02']]);
    expect(g[0].margin).toBeCloseTo(60, 5);
  });

  it('by month', () => {
    expect(S.groups(rows, S.KEYS.month).map(x => [x.key, x.soldFor])).toEqual([['2026-09', 48], ['2026-10', 16]]);
  });

  it('sorts by latest, highest sale, profit, loss, margin and cards, with unknown profits last', () => {
    const k = (l: Row[]) => l.map(x => x.sale.soldCAD);
    expect(k(S.sortRows(rows, 'latest'))).toEqual([4, 12, 8, 10, 30]);
    expect(k(S.sortRows(rows, 'sold'))).toEqual([30, 12, 10, 8, 4]);
    expect(k(S.sortRows(rows, 'profit'))).toEqual([30, 10, 4, 8, 12]);
    expect(k(S.sortRows(rows, 'loss'))).toEqual([8, 4, 10, 30, 12]);
    expect(k(S.sortRows(rows, 'margin'))).toEqual([4, 10, 30, 8, 12]);
    const g = S.sortRows(S.groups(rows, S.KEYS.where), 'cards');
    expect(g.map(x => x.key)).toEqual(['Card show', 'eBay', S.NOWHERE]);
  });

  it('filters by where, trimmed, with blank as Not recorded', () => {
    expect(S.matchWhere({ soldCAD: 1, where: ' eBay ' }, 'eBay')).toBe(true);
    expect(S.matchWhere({ soldCAD: 1 }, S.NOWHERE)).toBe(true);
    expect(S.matchWhere({ soldCAD: 1, where: 'eBay' }, 'Card show')).toBe(false);
    expect(S.matchWhere({ soldCAD: 1, where: 'eBay' }, '')).toBe(true);
  });
});
