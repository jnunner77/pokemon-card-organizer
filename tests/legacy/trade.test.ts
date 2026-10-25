import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/trade.js is a plain browser script; load it the way the page does.
type Typed = string | number | null | undefined;
type Side = { pct?: Typed; cash?: Typed; items?: { value: Typed; pct?: Typed }[] };
type SideResult = {
  pct: number; mixed: boolean; counted: number; unvalued: number; items: number;
  market: number; trade: number; cash: number; total: number; rate: number | null;
  unread: { cash: boolean; pct: boolean; cardPct: number };
};
type Result = {
  dealer: SideResult; mine: SideResult;
  even: { cash: number; who: 'dealer' | 'me' | null };
  get: number; give: number; net: number; netPct: number | null;
  verdict: 'ahead' | 'behind' | 'even' | 'empty';
  myRate: number | null; theirRate: number | null;
};
type Trade = {
  amount: (s: Typed) => number | null;
  percent: (s: Typed) => number | null;
  evaluate: (t: { dealer?: Side; mine?: Side }) => Result;
  gradeLabel: (grader: Typed, grade: Typed) => string;
  pctText: (n: number | null) => string;
};
const sandbox = { window: {} as { BinderTrade: Trade } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/trade.js'), 'utf8'), sandbox);
const { amount, percent, evaluate, gradeLabel, pctText } = sandbox.window.BinderTrade;

describe('reading what was typed', () => {
  it('reads amounts with or without a dollar sign and commas', () => {
    expect(amount('12.50')).toBe(12.5);
    expect(amount('$1,200')).toBe(1200);
    expect(amount(' 7 ')).toBe(7);
    expect(amount('.5')).toBe(0.5);
    expect(amount('CA$40')).toBe(40);
    expect(amount(25)).toBe(25);
  });

  it('reads blank, negative or garbled amounts as nothing', () => {
    for (const s of ['', '  ', 'abc', '-3', '1.2.3', null, undefined, Number.NaN, -1]) expect(amount(s)).toBeNull();
  });

  it('reads percentages with or without the % sign', () => {
    expect(percent('80')).toBe(80);
    expect(percent('80%')).toBe(80);
    expect(percent(' 72.5 % ')).toBe(72.5);
    expect(percent('0')).toBe(0);
    expect(percent('110')).toBe(110);
    for (const s of ['', 'abc', '-5', '1001', null]) expect(percent(s)).toBeNull();
  });

  it('shows grades and percentages', () => {
    expect(gradeLabel('PSA', '10')).toBe('PSA 10');
    expect(gradeLabel('BGS', ' 9.5 ')).toBe('BGS 9.5');
    expect(gradeLabel('Raw', '10')).toBe('');
    expect(gradeLabel('PSA', '')).toBe('');
    expect(pctText(87.345)).toBe('87.3');
    expect(pctText(80)).toBe('80');
    expect(pctText(null)).toBe('');
  });
});

describe('a trade with a dealer', () => {
  it('two of my cards and cash for a PSA 10, with my cards at 80%', () => {
    // dealer's PSA 10 is worth $300; my cards $150 and $100 at 80% = $200 credit, plus $100 cash
    const r = evaluate({
      dealer: { items: [{ value: '300' }] },
      mine: { pct: '80', cash: '100', items: [{ value: 150 }, { value: 100 }] },
    });
    expect(r.dealer).toMatchObject({ market: 300, trade: 300, cash: 0, total: 300, pct: 100 });
    expect(r.mine).toMatchObject({ market: 250, trade: 200, cash: 100, total: 300, pct: 80, rate: 80 });
    expect(r.even).toEqual({ cash: 0, who: null });
    // in market value I give $350 for $300
    expect(r.get).toBe(300);
    expect(r.give).toBe(350);
    expect(r.net).toBe(-50);
    expect(r.netPct).toBeCloseTo(-14.29, 2);
    expect(r.verdict).toBe('behind');
    // my $250 of cards fetch $300 − $100 cash = $200: 80%
    expect(r.myRate).toBe(80);
    // the $300 card costs me $250 of cards + $100 = $350: 116.7%
    expect(r.theirRate).toBeCloseTo(116.67, 2);
  });

  it('says how much cash evens the trade, and who adds it', () => {
    const short = evaluate({ dealer: { items: [{ value: 300 }] }, mine: { pct: 80, items: [{ value: 250 }] } });
    expect(short.even).toEqual({ cash: 100, who: 'me' });
    const over = evaluate({ dealer: { items: [{ value: 100 }] }, mine: { pct: 80, items: [{ value: 250 }] } });
    expect(over.even).toEqual({ cash: 100, who: 'dealer' });
  });

  it('applies the percentage to cards only, never to cash', () => {
    const r = evaluate({ dealer: { pct: 50, cash: 40, items: [{ value: 100 }] }, mine: { items: [] } });
    expect(r.dealer).toMatchObject({ market: 100, trade: 50, cash: 40, total: 90 });
    expect(r.get).toBe(140);
  });

  it('lets a card have its own percentage', () => {
    const r = evaluate({ mine: { pct: '80', items: [{ value: 200 }, { value: 50, pct: '50' }, { value: 10, pct: '80' }] } });
    expect(r.mine.trade).toBe(160 + 25 + 8);
    expect(r.mine.mixed).toBe(true);
    expect(r.mine.rate).toBeCloseTo(193 / 260 * 100, 6);
    const same = evaluate({ mine: { pct: '80', items: [{ value: 200, pct: '80' }] } });
    expect(same.mine.mixed).toBe(false);
  });

  it('works to the cent', () => {
    const r = evaluate({ mine: { pct: '70', items: [{ value: '0.99' }, { value: '0.99' }, { value: '0.99' }] } });
    // 69.3¢ each, rounded per card to 69¢
    expect(r.mine.trade).toBe(2.07);
    expect(r.mine.market).toBe(2.97);
    const sum = evaluate({ dealer: { items: [{ value: '0.1' }, { value: '0.2' }] } });
    expect(sum.dealer.market).toBe(0.3);
  });

  it('counts cards without a value as nothing, and says how many', () => {
    const r = evaluate({ dealer: { items: [{ value: '' }, { value: '20' }, { value: 'abc' }] } });
    expect(r.dealer).toMatchObject({ market: 20, counted: 1, unvalued: 2, items: 3 });
  });

  it("says when cash or a percentage was typed but can't be read", () => {
    const r = evaluate({ dealer: { cash: '40 dollars', pct: '80 pct', items: [{ value: 10, pct: 'lots' }, { value: 5, pct: '' }] } });
    expect(r.dealer.unread).toEqual({ cash: true, pct: true, cardPct: 1 });
    expect(r.dealer).toMatchObject({ cash: 0, pct: 100, trade: 15 });
    const fine = evaluate({ dealer: { cash: '', pct: '', items: [{ value: 10 }] }, mine: { cash: '$5', pct: '80%' } });
    expect(fine.dealer.unread).toEqual({ cash: false, pct: false, cardPct: 0 });
    expect(fine.mine.unread).toEqual({ cash: false, pct: false, cardPct: 0 });
  });

  it('takes a blank or garbled side percentage as 100%', () => {
    expect(evaluate({ mine: { pct: '', items: [{ value: 10 }] } }).mine).toMatchObject({ pct: 100, trade: 10 });
    expect(evaluate({ mine: { pct: 'x', items: [{ value: 10 }] } }).mine).toMatchObject({ pct: 100, trade: 10 });
  });

  it('calls it even within a dollar or half a percent', () => {
    expect(evaluate({ dealer: { items: [{ value: 100.5 }] }, mine: { items: [{ value: 100 }] } }).verdict).toBe('even');
    expect(evaluate({ dealer: { items: [{ value: 1004 }] }, mine: { items: [{ value: 1000 }] } }).verdict).toBe('even');
    expect(evaluate({ dealer: { items: [{ value: 1010 }] }, mine: { items: [{ value: 1000 }] } }).verdict).toBe('ahead');
    expect(evaluate({ dealer: { items: [{ value: 98 }] }, mine: { items: [{ value: 100 }] } }).verdict).toBe('behind');
  });

  it('handles an empty trade and one-sided ones', () => {
    const empty = evaluate({});
    expect(empty.verdict).toBe('empty');
    expect(empty.netPct).toBeNull();
    expect(empty.myRate).toBeNull();
    expect(empty.theirRate).toBeNull();
    // selling my cards to the dealer for cash at 60%
    const sale = evaluate({ dealer: { cash: 60 }, mine: { pct: 60, items: [{ value: 100 }] } });
    expect(sale.even.who).toBeNull();
    expect(sale.myRate).toBe(60);
    expect(sale.theirRate).toBeNull();
    // buying the dealer's card for cash
    const buy = evaluate({ dealer: { items: [{ value: 100 }] }, mine: { cash: 90 } });
    expect(buy.verdict).toBe('ahead');
    expect(buy.theirRate).toBe(90);
    expect(buy.myRate).toBeNull();
  });
});
