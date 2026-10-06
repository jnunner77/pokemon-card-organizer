import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/portfolio.js is a plain browser script; load it the way the page does.
type Card = Record<string, unknown>;
type Point = { date: string; value: number };
type Row = { card: Card; start: number; end: number; change: number; pct: number | null };
interface Portfolio {
  addDays: (d: string, n: number) => string;
  history: (c: Card, value: (c: Card, p: { amount: number; auto?: boolean }) => number | null) => Point[];
  valueAt: (h: Point[], date: string) => number | null;
  range: (key: string, today: string, custom?: { from?: string; to?: string }, earliest?: string) => { from: string; to: string };
  dates: (from: string, to: string, max?: number) => string[];
  series: (hists: Point[][], from: string, to: string, max?: number) => Point[];
  movers: (items: { card: Card; hist: Point[] }[], from: string, to: string) => Row[];
  groups: (rows: Row[], keyOf: (c: Card) => string) => { key: string; n: number; start: number; end: number; change: number; pct: number | null }[];
  sortRows: (rows: Row[], k: string) => Row[];
  columnSort: (col: string, current: string) => string;
  sortColumn: (k: string) => { col: string; dir: number } | null;
}
const sandbox = { window: {} as { BinderPortfolio: Portfolio } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/portfolio.js'), 'utf8'), sandbox);
const P = sandbox.window.BinderPortfolio;
const plain = (_c: Card, p: { amount: number }) => p.amount;
const m = (date: string, amount: number, extra: object = {}) => ({ type: 'market', amount, currency: 'CAD', date, ...extra });

describe('a card’s value history', () => {
  it('keeps market and sold-comp prices, oldest first, the last one of each day', () => {
    const c = { prices: [m('2026-09-03', 12), { type: 'paid', amount: 5, date: '2026-09-01' }, m('2026-09-01', 10), m('2026-09-03', 13, { at: '2026-09-03T15:00:00Z' }), { type: 'comp', amount: 9, date: '2026-09-02' }, m('', 99)] };
    expect(P.history(c, plain)).toEqual([{ date: '2026-09-01', value: 10 }, { date: '2026-09-02', value: 9 }, { date: '2026-09-03', value: 13 }]);
  });

  it('uses the page’s value of each price (condition, currency)', () => {
    const c = { prices: [m('2026-09-01', 10, { auto: true })] };
    expect(P.history(c, (_c, p) => (p.auto ? p.amount * 0.85 : p.amount))).toEqual([{ date: '2026-09-01', value: 8.5 }]);
  });

  it('values a date at the latest price on or before it, or the first price before there is one', () => {
    const h = [{ date: '2026-09-01', value: 10 }, { date: '2026-09-05', value: 14 }];
    expect(P.valueAt(h, '2026-09-04')).toBe(10);
    expect(P.valueAt(h, '2026-09-05')).toBe(14);
    expect(P.valueAt(h, '2026-12-01')).toBe(14);
    expect(P.valueAt(h, '2026-01-01')).toBe(10);
    expect(P.valueAt([], '2026-09-01')).toBeNull();
  });
});

describe('date ranges', () => {
  it('counts back from today for the presets', () => {
    expect(P.range('7d', '2026-10-05')).toEqual({ from: '2026-09-28', to: '2026-10-05' });
    expect(P.range('1y', '2026-10-05')).toEqual({ from: '2025-10-05', to: '2026-10-05' });
  });

  it('starts All at the first price, and keeps a custom range in order and not past today', () => {
    expect(P.range('all', '2026-10-05', undefined, '2026-08-14')).toEqual({ from: '2026-08-14', to: '2026-10-05' });
    expect(P.range('all', '2026-10-05')).toEqual({ from: '2026-09-05', to: '2026-10-05' });
    expect(P.range('custom', '2026-10-05', { from: '2026-09-20', to: '2026-09-01' })).toEqual({ from: '2026-09-01', to: '2026-09-20' });
    expect(P.range('custom', '2026-10-05', { from: '2026-09-20', to: '2027-01-01' })).toEqual({ from: '2026-09-20', to: '2026-10-05' });
  });

  it('plots every day for short ranges and spaced-out days for long ones, ending on the last day', () => {
    expect(P.dates('2026-09-28', '2026-10-01')).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
    const year = P.dates('2025-10-05', '2026-10-05');
    expect(year.length).toBeLessThanOrEqual(123);
    expect(year[0]).toBe('2025-10-05');
    expect(year[year.length - 1]).toBe('2026-10-05');
    expect(P.dates('2026-10-05', '2026-10-05')).toEqual(['2026-10-05']);
  });
});

describe('totals and movers', () => {
  const lapras = { name: 'Lapras', set: '30th', owner: 'Megan' };
  const pika = { name: 'Pikachu', set: 'SVP', owner: 'Justin' };
  const mew = { name: 'Mew', set: '30th', owner: 'Justin' };
  const items = [
    { card: lapras, hist: [{ date: '2026-09-01', value: 10 }, { date: '2026-09-03', value: 16 }] },
    { card: pika, hist: [{ date: '2026-09-02', value: 5 }, { date: '2026-09-03', value: 4 }] },
    { card: mew, hist: [{ date: '2026-09-01', value: 20 }] },
    { card: { name: 'Unpriced' }, hist: [] },
  ];

  it('adds up every priced card on each date', () => {
    expect(P.series(items.map((x) => x.hist), '2026-09-01', '2026-09-03')).toEqual([
      { date: '2026-09-01', value: 35 },
      { date: '2026-09-02', value: 35 },
      { date: '2026-09-03', value: 40 },
    ]);
  });

  it('gives each priced card its change, and adds them up by set', () => {
    const rows = P.movers(items, '2026-09-01', '2026-09-03');
    expect(rows.map((r) => [r.card.name, r.start, r.end, r.change])).toEqual([['Lapras', 10, 16, 6], ['Pikachu', 5, 4, -1], ['Mew', 20, 20, 0]]);
    expect(rows[0].pct).toBe(60);
    expect(P.sortRows(rows, 'drop').map((r) => r.card.name)).toEqual(['Pikachu', 'Mew', 'Lapras']);
    expect(P.sortRows(rows, 'value').map((r) => r.card.name)).toEqual(['Mew', 'Lapras', 'Pikachu']);
    expect(P.groups(rows, (c) => c.set as string)).toEqual([
      { key: '30th', n: 2, start: 30, end: 36, change: 6, pct: 20 },
      { key: 'SVP', n: 1, start: 5, end: 4, change: -1, pct: -20 },
    ]);
  });
});

describe('sorting what moved', () => {
  const row = (name: string, start: number, end: number): Row => ({ card: { name }, start, end, change: end - start, pct: start > 0 ? ((end - start) / start) * 100 : null });
  // Charizard: +$20 (+10%), Eevee: +$3 (+60%), Gengar: −$8 (−40%), Zubat: −$1 (−50%), Ditto: new, +$4 (no %)
  const rows = [row('Charizard', 200, 220), row('Eevee', 5, 8), row('Gengar', 20, 12), row('Zubat', 2, 1), row('Ditto', 0, 4)];
  const names = (k: string) => P.sortRows(rows, k).map((r) => r.card.name);

  it('sorts by change and by %, high to low and low to high', () => {
    expect(names('gain')).toEqual(['Charizard', 'Ditto', 'Eevee', 'Zubat', 'Gengar']);
    expect(names('drop')).toEqual(['Gengar', 'Zubat', 'Eevee', 'Ditto', 'Charizard']);
    expect(names('pctGain')).toEqual(['Eevee', 'Charizard', 'Gengar', 'Zubat', 'Ditto']);
    expect(names('pctDrop')).toEqual(['Zubat', 'Gengar', 'Charizard', 'Eevee', 'Ditto']);
  });

  it('sorts by the size of the move, and by end or start value either way', () => {
    expect(names('change')).toEqual(['Charizard', 'Gengar', 'Ditto', 'Eevee', 'Zubat']);
    expect(names('pct')).toEqual(['Eevee', 'Zubat', 'Gengar', 'Charizard', 'Ditto']);
    expect(names('value')).toEqual(['Charizard', 'Gengar', 'Eevee', 'Ditto', 'Zubat']);
    expect(names('valueLow')).toEqual(['Zubat', 'Ditto', 'Eevee', 'Gengar', 'Charizard']);
    expect(names('start')).toEqual(['Charizard', 'Gengar', 'Eevee', 'Zubat', 'Ditto']);
    expect(names('startLow')).toEqual(['Ditto', 'Zubat', 'Eevee', 'Gengar', 'Charizard']);
    expect(names('nonsense')).toEqual(names('change'));
  });

  it('flips a column heading between high to low and low to high', () => {
    expect(P.columnSort('change', 'value')).toBe('gain');
    expect(P.columnSort('change', 'gain')).toBe('drop');
    expect(P.columnSort('change', 'drop')).toBe('gain');
    expect(P.columnSort('pct', 'pct')).toBe('pctGain');
    expect(P.columnSort('pct', 'pctGain')).toBe('pctDrop');
    expect(P.columnSort('end', 'gain')).toBe('value');
    expect(P.columnSort('start', 'start')).toBe('startLow');
    expect(P.sortColumn('pctDrop')).toEqual({ col: 'pct', dir: 1 });
    expect(P.sortColumn('value')).toEqual({ col: 'end', dir: -1 });
    expect(P.sortColumn('change')).toBeNull();
  });
});
