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
type Settled = { missing: number; forTheirs: number; forMine: number; paid: number[]; sold: number[]; gaveCash: number; gotCash: number };
type Trade = {
  settle: (t: { dealer?: Side; mine?: Side }) => Settled;
  newCard: (it: { look?: Look | null; name?: string; grader?: string; grade?: string }) => Record<string, string>;
  recordProblem: (t: unknown, lands: string[], given: number) => string;
  recordBody: (t: unknown, o: Record<string, unknown>) => any;
  landings: (items: { key: string; ph: string | null; phIds: string[] }[], before: Record<string, string> | null | undefined, binderIds: string[]) => Record<string, string>;
  salesGroups: (sales: unknown[], cards: unknown[]) => any[];
  amount: (s: Typed) => number | null;
  percent: (s: Typed) => number | null;
  evaluate: (t: { dealer?: Side; mine?: Side }) => Result;
  cardTrade: (value: number, pct: number) => number;
  gradeLabel: (grader: Typed, grade: Typed) => string;
  pctText: (n: number | null) => string;
  pctCell: (s: SideResult) => { text: string; overall: boolean } | null;
  warnings: (r: Result) => string[];
  gradePrice: (grades: { label: string; cad: number }[], grader: string, grade: string) => { label: string; cad: number; exact: boolean } | null;
  lookFrom: (hit: unknown, card: unknown) => Look;
  lookValue: (look: Look, grader: string, grade: string) => { value: number; from: string } | { value: null; why: string };
  addCash: (cash: string, add: number) => string;
  followLook: (it: { value: string; valueFrom: string }, lv: { value: number; from: string } | { value: null; why: string }) => { value: string; valueFrom: string };
  missingGradeNote: (it: Grade) => string | null;
  restore: (saved: unknown, ownedIds: Set<string> | null, graders: string[]) => Record<'dealer' | 'mine', SavedSide>;
};
type Grade = { grader?: string; grade?: string };
type Printing = { label: string; variant?: string; cad: number | null; grades: { label: string; cad: number }[] };
type Look = { id: string; name: string; set: string; number: string; thumb: string; printings: Printing[] | null; pi: number };
type SavedItem = { cardId: string | null; look: Look | null; name: string; grader: string; grade: string; value: string; valueFrom: string; pct: string };
type SavedSide = { pct: string; cash: string; items: SavedItem[] };
const sandbox = { window: {} as { BinderTrade: Trade } };
// bulkbuy.js comes first, as on the page: trade.js shares amounts out with its allocate.
for (const f of ['bulkbuy.js', 'trade.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8'), sandbox);
const { settle, newCard, recordProblem, recordBody, landings, salesGroups, amount, percent, evaluate, cardTrade, gradeLabel, pctText, pctCell, warnings, missingGradeNote, gradePrice, lookFrom, lookValue, followLook, addCash, restore } = sandbox.window.BinderTrade;

describe('reading what was typed', () => {
  it('reads amounts with or without a dollar sign and commas', () => {
    expect(amount('12.50')).toBe(12.5);
    expect(amount('$1,200')).toBe(1200);
    expect(amount(' 7 ')).toBe(7);
    expect(amount('.5')).toBe(0.5);
    expect(amount('CA$40')).toBe(40);
    expect(amount('C$25')).toBe(25);
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

  it('adds the cash that evens it to a side\'s cash, to the cent', () => {
    expect(addCash('40', 12.5)).toBe('52.50');
    expect(addCash('', 0.1)).toBe('0.10');
    expect(addCash('$1,000.10', 0.2)).toBe('1000.30');
    expect(addCash('forty', 10)).toBe('10.00');
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

  it("shows each card's trade value as the breakdown counts it", () => {
    expect(cardTrade(0.29, 50)).toBe(0.15);
    expect(cardTrade(1.15, 50)).toBe(0.58);
    for (const value of [0.29, 1.15, 0.99, 12.34, 19.99]) {
      for (const pct of [50, 70, 72.5, 80, 85, 110]) {
        expect(cardTrade(value, pct)).toBe(evaluate({ mine: { pct, items: [{ value }] } }).mine.trade);
      }
    }
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

describe('the trade kept in the browser', () => {
  const GRADERS = ['Raw', 'PSA', 'CGC', 'BGS', 'TAG', 'ACE'];
  const blank = { pct: '100', cash: '', items: [] };

  it('gives an empty trade for anything that is not a saved trade', () => {
    for (const saved of [null, undefined, 'x', 42, [], { dealer: 'x', mine: 5 }]) {
      expect(restore(saved, null, GRADERS)).toEqual({ dealer: blank, mine: blank });
    }
  });

  it('reads each field back as text, and an unknown grader as Raw', () => {
    const t = restore({ dealer: { pct: 90, cash: '20', items: [{ name: 'Umbreon VMAX', grader: 'PSA', grade: '10', value: 400, pct: '' }, { name: 'Odd', grader: 'XYZ', grade: 9 }, null, 'junk'] } }, null, GRADERS);
    expect(t.dealer.pct).toBe('90');
    expect(t.dealer.cash).toBe('20');
    expect(t.dealer.items).toEqual([
      { cardId: null, look: null, name: 'Umbreon VMAX', grader: 'PSA', grade: '10', value: '400', valueFrom: '', pct: '' },
      { cardId: null, look: null, name: 'Odd', grader: 'Raw', grade: '9', value: '', valueFrom: '', pct: '' },
    ]);
    expect(t.mine).toEqual(blank);
  });

  it("links only my side's cards to cards of mine, and only the dealer's to looked-up cards", () => {
    const look = { id: 'swsh7-215', name: 'Umbreon VMAX', set: 'Evolving Skies', number: '215/203', thumb: 't.png', printings: [{ label: 'regular', cad: 590.5, grades: [{ label: 'PSA 10', cad: 2400 }] }], pi: 0 };
    const t = restore({ dealer: { items: [{ cardId: 'a', look, value: '2400.00', valueFrom: "PriceCharting's PSA 10 price" }] }, mine: { items: [{ cardId: 'a', look }] } }, null, GRADERS);
    expect(t.dealer.items[0]).toMatchObject({ cardId: null, look, valueFrom: "PriceCharting's PSA 10 price" });
    expect(t.mine.items[0]).toMatchObject({ cardId: 'a', look: null });
  });

  it('reads a looked-up card back, asking for its prices again when they had not come', () => {
    const r = (look: unknown) => restore({ dealer: { items: [{ look }] } }, null, GRADERS).dealer.items[0].look;
    expect(r({ id: 'x', name: 'Mew', printings: null })).toMatchObject({ id: 'x', name: 'Mew', printings: null, pi: 0 });
    expect(r({ id: 'x', printings: [{ label: 'regular', cad: 'abc', grades: [{ label: 'PSA 10', cad: 5 }, { label: 'bad' }] }], pi: 4 }))
      .toEqual({ id: 'x', name: '', set: '', number: '', thumb: '', printings: [{ label: 'regular', variant: '', cad: null, grades: [{ label: 'PSA 10', cad: 5 }] }], pi: 0 });
    for (const bad of [null, 'x', {}, { id: '' }, { id: 7 }]) expect(r(bad)).toBeNull();
  });

  it('drops my cards that are gone, sold or traded once the ledger is loaded, and keeps typed-in ones', () => {
    const saved = { mine: { items: [{ cardId: 'kept', name: 'Charizard ex' }, { cardId: 'sold', name: 'Mew ex' }, { cardId: null, name: 'Typed in' }] } };
    expect(restore(saved, new Set(['kept']), GRADERS).mine.items.map((i) => i.name)).toEqual(['Charizard ex', 'Typed in']);
    // not loaded yet (or no server): nothing is dropped
    expect(restore(saved, null, GRADERS).mine.items.map((i) => i.name)).toEqual(['Charizard ex', 'Mew ex', 'Typed in']);
  });
});

describe('what the breakdown says', () => {
  it("shows the side's trade %, the overall rate when cards differ, or nothing", () => {
    expect(pctCell(evaluate({ mine: { pct: '80', items: [{ value: 100 }] } }).mine)).toEqual({ text: '80%', overall: false });
    expect(pctCell(evaluate({ mine: { pct: '80', items: [{ value: 100 }, { value: 100, pct: '50' }] } }).mine)).toEqual({ text: '65%', overall: true });
    expect(pctCell(evaluate({ mine: { items: [] } }).mine)).toBeNull();
    // cards differ but are all worth $0: no overall rate to show
    expect(pctCell(evaluate({ mine: { pct: '80', items: [{ value: '0', pct: '50' }] } }).mine)).toBeNull();
  });

  it('warns about cards with no value and cash or percentages it cannot read', () => {
    expect(warnings(evaluate({ dealer: { items: [{ value: 5 }] } }))).toEqual([]);
    expect(warnings(evaluate({ dealer: { items: [{ value: '' }] } }))).toEqual(["1 card has no value yet and isn't counted."]);
    expect(warnings(evaluate({
      dealer: { cash: 'forty', items: [{ value: '' }, { value: '' }] },
      mine: { pct: '80 pct', items: [{ value: 5, pct: 'x' }, { value: 5, pct: 'y' }] },
    }))).toEqual([
      "2 cards have no value yet and aren't counted.",
      "The dealer's cash isn't a number, so it counts as $0.00. Your trade % isn't a number, so it counts as 100%. 2 of your cards' own % aren't numbers, so they use the side's.",
    ]);
  });

  it('asks for the grade of a typed-in graded card', () => {
    expect(missingGradeNote({ grader: 'PSA', grade: '' })).toBe('Put in its PSA grade.');
    expect(missingGradeNote({ grader: 'PSA', grade: '10' })).toBeNull();
    expect(missingGradeNote({ grader: 'Raw', grade: '' })).toBeNull();
  });
});

describe('a card looked up in the card database', () => {
  const grades = [
    { label: 'Grade 7', cad: 70 }, { label: 'Grade 8', cad: 80 }, { label: 'Grade 9', cad: 90 }, { label: 'Grade 9.5', cad: 95 },
    { label: 'PSA 10', cad: 300 }, { label: 'BGS 10', cad: 280 }, { label: 'CGC 10', cad: 200 },
    { label: 'CGC 10 Pristine', cad: 400 }, { label: 'BGS 10 Black Label', cad: 900 },
  ];

  it("finds PriceCharting's price for a grader and grade", () => {
    expect(gradePrice(grades, 'PSA', '10')).toEqual({ label: 'PSA 10', cad: 300, exact: true });
    expect(gradePrice(grades, 'CGC', '10')).toEqual({ label: 'CGC 10', cad: 200, exact: true });
    expect(gradePrice(grades, 'PSA', '9')).toEqual({ label: 'Grade 9', cad: 90, exact: true });
    expect(gradePrice(grades, 'BGS', '9.5')).toEqual({ label: 'Grade 9.5', cad: 95, exact: true });
    // 7.5 and 8.5 are priced as 7 and 8
    expect(gradePrice(grades, 'CGC', '8.5')).toEqual({ label: 'Grade 8', cad: 80, exact: true });
    expect(gradePrice(grades, 'CGC', '10 Pristine')).toEqual({ label: 'CGC 10 Pristine', cad: 400, exact: true });
    expect(gradePrice(grades, 'BGS', '10 Black Label')).toEqual({ label: 'BGS 10 Black Label', cad: 900, exact: true });
  });

  it("takes the nearest grade when PriceCharting has none for it, never a Pristine or Black Label for a plain 10", () => {
    // TAG 10: a 10 by PSA before another grader's
    expect(gradePrice(grades, 'TAG', '10')).toEqual({ label: 'PSA 10', cad: 300, exact: false });
    expect(gradePrice([{ label: 'CGC 10 Pristine', cad: 400 }, { label: 'Grade 9', cad: 90 }], 'CGC', '10')).toEqual({ label: 'Grade 9', cad: 90, exact: false });
    // 6: Grade 7 is nearest
    expect(gradePrice(grades, 'PSA', '6')).toEqual({ label: 'Grade 7', cad: 70, exact: false });
  });

  it('has no graded price for a raw card, an unreadable grade, or no graded prices', () => {
    expect(gradePrice(grades, 'Raw', '10')).toBeNull();
    expect(gradePrice(grades, 'PSA', '')).toBeNull();
    expect(gradePrice(grades, 'PSA', 'mint')).toBeNull();
    expect(gradePrice([], 'PSA', '10')).toBeNull();
  });

  const hit = { id: 'swsh7-215', name: 'Umbreon VMAX', set: 'Evolving Skies', number: '215', total: 203, thumb: 't.png' };
  const card = { image: 'big.png', printings: [
    { label: 'regular', variant: '', price: null, pricecharting: null },
    { label: 'holo', variant: 'Holo', price: { cad: 590.5, usd: 430, summary: 'x' }, pricecharting: { grades: [{ label: 'PSA 10', usd: 1750, cad: 2400 }, { label: 'Grade 9', usd: 500, cad: 690 }] } },
  ] };

  it('keeps what the trade needs from the card database: each printing with its price and graded prices', () => {
    expect(lookFrom(hit, card)).toEqual({
      id: 'swsh7-215', name: 'Umbreon VMAX', set: 'Evolving Skies', number: '215/203', thumb: 't.png', pi: 1,
      printings: [
        { label: 'regular', variant: '', cad: null, grades: [] },
        { label: 'holo', variant: 'Holo', cad: 590.5, grades: [{ label: 'PSA 10', cad: 2400 }, { label: 'Grade 9', cad: 690 }] },
      ],
    });
    expect(lookFrom({ id: 'p', name: 'Pikachu', set: 'Promos', number: 'SWSH050' }, null)).toMatchObject({ number: 'SWSH050', printings: [], pi: 0 });
  });

  it("is worth its printing's price, or its grade's", () => {
    const look = lookFrom(hit, card);
    expect(lookValue(look, 'Raw', '')).toEqual({ value: 590.5, from: "today's price, holo" });
    expect(lookValue(look, 'PSA', '10')).toEqual({ value: 2400, from: "PriceCharting's PSA 10 price" });
    expect(lookValue(look, 'CGC', '9')).toEqual({ value: 690, from: "PriceCharting's Grade 9 price" });
    expect(lookValue(look, 'BGS', '10')).toEqual({ value: 2400, from: "PriceCharting's PSA 10 price (it has none for BGS 10)" });
    // a grader with no grade yet: the raw price
    expect(lookValue(look, 'PSA', '')).toEqual({ value: 590.5, from: "today's price, holo" });
    expect(lookValue({ ...look, pi: 0 }, 'Raw', '')).toEqual({ value: null, why: 'No price for the regular' });
    expect(lookValue({ ...look, pi: 0 }, 'PSA', '10')).toEqual({ value: null, why: 'No PSA 10 price from PriceCharting' });
    expect(lookValue({ ...look, printings: [] }, 'Raw', '')).toEqual({ value: null, why: 'No prices for this card' });
  });

  it('follows the printing and grade: a price replaces the value, none clears a looked-up one but keeps a typed one', () => {
    const priced = { value: 2400, from: "PriceCharting's PSA 10 price" }, none = { value: null, why: 'No PSA 10 price from PriceCharting' };
    expect(followLook({ value: '590.50', valueFrom: "today's price, holo" }, priced)).toEqual({ value: '2400.00', valueFrom: "PriceCharting's PSA 10 price" });
    expect(followLook({ value: '5000', valueFrom: '' }, priced)).toEqual({ value: '2400.00', valueFrom: "PriceCharting's PSA 10 price" });
    expect(followLook({ value: '590.50', valueFrom: "today's price, holo" }, none)).toEqual({ value: '', valueFrom: '' });
    expect(followLook({ value: '5000', valueFrom: '' }, none)).toEqual({ value: '5000', valueFrom: '' });
  });
});

describe('recording the trade', () => {
  it('splits what I gave across the dealer’s cards, and what I got across mine, by value', () => {
    // My $100 and $50 cards and $20 cash for their $120 and $60 cards
    const r = settle({ dealer: { items: [{ value: '120' }, { value: '60' }] }, mine: { cash: '20', items: [{ value: '100' }, { value: '50' }] } });
    expect(r).toEqual({ missing: 0, forTheirs: 170, forMine: 160, paid: [113.33, 56.67], sold: [106.67, 53.33], gaveCash: 20, gotCash: 0 });
  });

  it('takes the dealer’s cash off what their cards cost me, never below $0', () => {
    const r = settle({ dealer: { cash: '30', items: [{ value: 50 }] }, mine: { items: [{ value: 100 }] } });
    expect([r.paid, r.sold, r.gotCash]).toEqual([[70], [80], 30]);
    // the dealer pays more cash than my cards are worth: their card cost me nothing
    expect(settle({ dealer: { cash: '200', items: [{ value: 50 }] }, mine: { items: [{ value: 100 }] } }).paid).toEqual([0]);
  });

  it('is a sale for cash or a purchase for cash when one side has only cash', () => {
    expect(settle({ dealer: { cash: '80' }, mine: { items: [{ value: 100 }] } })).toMatchObject({ sold: [80], paid: [], forTheirs: 20 });
    expect(settle({ dealer: { items: [{ value: 100 }] }, mine: { cash: '$90' } })).toMatchObject({ paid: [90], sold: [] });
  });

  it('shares evenly among cards worth $0 and counts the cards with no value yet', () => {
    expect(settle({ dealer: { items: [{ value: 0 }, { value: '0' }] }, mine: { cash: '10' } }).paid).toEqual([5, 5]);
    expect(settle({ dealer: { items: [{ value: '' }, { value: 'abc' }] }, mine: { items: [{ value: 10 }] } }).missing).toBe(2);
  });

  it('makes the card a dealer’s card becomes: looked up with its printing, or typed in', () => {
    const hit = { id: 'swsh7-215', name: 'Umbreon VMAX', set: 'Evolving Skies', number: '215', total: 203 };
    const look = { ...lookFrom(hit, { printings: [{ label: 'regular' }, { label: 'holo', variant: 'Holo', price: { cad: 590.5 } }] }), pi: 1 };
    expect(newCard({ look, grader: 'PSA', grade: ' 10 ' })).toEqual({ name: 'Umbreon VMAX', set: 'Evolving Skies', number: '215/203', variant: 'Holo', grader: 'PSA', grade: '10' });
    expect(newCard({ look: null, name: ' Mew ex ', grader: 'Raw', grade: '9' })).toEqual({ name: 'Mew ex', set: '', number: '', variant: '', grader: 'Raw', grade: '' });
  });

  it('says what stops the trade being recorded', () => {
    const t = (dealer: unknown[], mine: unknown[] = []) => ({ dealer: { items: dealer }, mine: { items: mine } });
    expect(recordProblem(t([{ name: 'Mew', value: '' }]), [''], 0)).toBe("1 card has no value yet. Go back and put it in.");
    expect(recordProblem(t([], [{ value: 5 }]), [], 0)).toBe("There's nothing in your ledger to change: add the dealer's cards, or cards of yours.");
    expect(recordProblem(t([{ name: ' ', value: 5 }]), [''], 0)).toBe('Give every card you get a name. Go back and type it in.');
    expect(recordProblem(t([{ name: 'A', value: 5 }, { name: 'B', value: 5 }]), ['ph:x', 'ph:x'], 0)).toBe('Two cards fill the same placeholder: choose somewhere else for one of them.');
    expect(recordProblem(t([{ name: 'A', value: 5 }, { name: 'B', value: 5 }]), ['ph:x', 'b:b1'], 0)).toBe('');
    expect(recordProblem(t([], [{ value: 5 }]), [], 1)).toBe('');
  });
});

describe('the trade as it is recorded', () => {
  let n = 0;
  const o = (over: Record<string, unknown> = {}) => ({ id: 't1', date: '2026-10-25', at: 'AT', who: 'Shop', newId: () => `id${++n}`, owner: (b: string | null) => (b ? 'Megan' : 'Justin'), ...over });
  const trade = {
    dealer: { cash: '', items: [{ name: 'Mew ex', grader: 'PSA', grade: '10', value: '120', valueFrom: '' }, { name: 'Pikachu', grader: 'Raw', grade: '', value: '60', valueFrom: "today's price, holo" }] },
    mine: { cash: '20', items: [{ value: '100' }, { value: '50' }] },
  };

  it('sells my ledger cards for their share, with profit, and skips a typed-in card of mine', () => {
    n = 0;
    const body = recordBody(trade, o({ mine: [{ cardId: 'c1', cost: 60, basis: 'paid' }, null], lands: ['ph:p1', ''] }));
    expect(body.id).toBe('t1');
    expect(body.summary).toEqual({ date: '2026-10-25', gaveCash: 20, gotCash: 0, gave: 2, got: 2, with: 'Shop' });
    expect(body.given).toEqual([{
      id: 'c1',
      entry: { id: 'id1', at: 'AT', type: 'mysale', amount: 106.67, currency: 'CAD', date: '2026-10-25', where: 'Trade', note: 'Trade with Shop: 2 cards + $20.00 for 2 cards' },
      sale: { amount: 106.67, currency: 'CAD', soldCAD: 106.67, cost: 60, basis: 'paid', profit: 46.67, date: '2026-10-25', where: 'Trade', at: 'AT' },
    }]);
  });

  it('fills a placeholder or adds a new card, each with its Paid share and its value', () => {
    n = 0;
    const body = recordBody(trade, o({ who: '', mine: [null, null], lands: ['ph:p1', 'b:b1'] }));
    expect(body.summary).not.toHaveProperty('with');
    const [ph, fresh] = body.received;
    expect(ph).toMatchObject({ id: 'p1', placeholder: true, grader: 'PSA', grade: '10' });
    expect(ph.entries.map((e: { type: string; amount: number }) => [e.type, e.amount])).toEqual([['paid', 113.33], ['market', 120]]);
    expect(fresh).toMatchObject({ binderId: 'b1', doc: { name: 'Pikachu', grader: 'Raw', owner: 'Megan', language: 'English', condition: 'Near Mint' } });
    expect(fresh.entries[1].note).toBe("Value in the trade: today's price, holo");
    expect(recordBody(trade, o({ mine: [null, null], lands: ['', ''] })).received[0]).toMatchObject({ binderId: null, doc: { owner: 'Justin' } });
    // cash only on my side
    const cash = recordBody({ dealer: trade.dealer, mine: { cash: '70', items: [] } }, o({ who: '', mine: [], lands: ['', ''] }));
    expect(cash.received[0].entries[0].note).toBe('Trade: $70.00 for 2 cards');
  });
});

describe('where the cards I get go, and the Sales tab', () => {
  it('starts each card at its placeholder or no binder, and keeps a choice still on offer', () => {
    const items = [{ key: 'a', ph: 'p1', phIds: ['p1', 'p2'] }, { key: 'b', ph: null, phIds: [] }, { key: 'c', ph: null, phIds: [] }];
    expect(landings(items, undefined, ['b1'])).toEqual({ a: 'ph:p1', b: '', c: '' });
    expect(landings(items, { a: 'ph:p2', b: 'b:b1', c: '' }, ['b1'])).toEqual({ a: 'ph:p2', b: 'b:b1', c: '' });
    // a binder deleted meanwhile, a placeholder no longer free for it
    expect(landings(items, { a: 'ph:gone', b: 'b:old' }, ['b1'])).toEqual({ a: 'ph:p1', b: '', c: '' });
  });

  it('groups bundles and trades, adds a cash-only trade by the cards I got, newest first', () => {
    const sale = (id: string, date: string, extra: Record<string, unknown> = {}) => ({ c: { id }, s: { date, ...extra } });
    const sales = [
      sale('x', '2026-10-20', { trade: { id: 't1' } }),
      sale('y', '2026-10-20', { trade: { id: 't1' } }),
      sale('z', '2026-10-10', { bundle: { id: 'b1' } }),
      sale('w', '2026-10-05'),
    ];
    const cards = [{ id: 'got1', trade: { id: 't1' } }, { id: 'got2', trade: { id: 't2', date: '2026-10-15' } }, { id: 'plain' }];
    const g = salesGroups(sales, cards);
    expect(g.map((x) => x.trade?.id ?? x.bundle?.id ?? x.c.id)).toEqual(['t1', 't2', 'b1', 'w']);
    expect(g[0].items.map((x: { c: { id: string } }) => x.c.id)).toEqual(['x', 'y']);
    expect(g[1]).toEqual({ trade: { id: 't2', date: '2026-10-15' }, items: [] });
    expect(salesGroups([], [{ id: 'plain' }])).toEqual([]);
  });
});
