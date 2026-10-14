import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/bulkbuy.js is a plain browser script; load it the way the page does.
type Card = { id: string; name?: string; number?: string; set?: string; setCode?: string; variant?: string; language?: string; placeholder?: boolean; status?: string; slot?: number };
type Row = { name?: string; number?: string; price?: string; pick?: string };
type Result = { status: string; cardId?: string; reason?: string; pick?: string; printings?: { key: string; card: Card; free: number }[] };
type Bulk = {
  match: (rows: Row[], cards: Card[], options?: { order?: (c: Card) => string | number }) => Result[];
  allocate: (tax: number, prices: (number | null)[]) => number[];
  cost: (price: number, share: number) => number;
  numberMatches: (typed: string, card: string) => boolean;
  nameScore: (typed: string, card: string) => number;
  printingKey: (c: Card) => string;
};
const sandbox = { window: {} as { BinderBulkBuy: Bulk } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/bulkbuy.js'), 'utf8'), sandbox);
const { match, allocate, cost, numberMatches, nameScore, printingKey } = sandbox.window.BinderBulkBuy;
const sum = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) * 100) / 100;
const order = { order: (c: Card) => String(c.slot ?? 0).padStart(3, '0') };

const ph = (id: string, name: string, number: string, more: Partial<Card> = {}): Card => ({ id, name, number, set: '151', setCode: 'MEW', placeholder: true, ...more });

describe('matching a card number', () => {
  it('ignores leading zeros and a missing set size', () => {
    expect(numberMatches('51', '051/162')).toBe(true);
    expect(numberMatches('051/162', '51/162')).toBe(true);
    expect(numberMatches('51/162', '51')).toBe(true);
    expect(numberMatches('#51', '51/162')).toBe(true);
  });

  it('keeps different numbers and set sizes apart', () => {
    expect(numberMatches('51/165', '51/162')).toBe(false);
    expect(numberMatches('5', '51/162')).toBe(false);
    expect(numberMatches('', '51/162')).toBe(false);
  });

  it('matches letter numbers', () => {
    expect(numberMatches('tg10', 'TG10/TG30')).toBe(true);
    expect(numberMatches('SWSH 298', 'SWSH298')).toBe(true);
    expect(numberMatches('TG1', 'TG10/TG30')).toBe(false);
  });
});

describe('matching a card name', () => {
  it('ignores case, accents and spacing', () => {
    expect(nameScore('flabebe', 'Flabébé')).toBe(2);
    expect(nameScore('arceus v star', 'Arceus VSTAR')).toBe(2);
    expect(nameScore("farfetch'd", 'Farfetchd')).toBe(2);
  });

  it('finds a longer name from its first words, as a weaker match', () => {
    expect(nameScore('pikachu', 'Pikachu ex')).toBe(1);
    expect(nameScore('char ex', 'Charizard ex')).toBe(1);
    expect(nameScore('raichu', 'Pikachu ex')).toBe(0);
    expect(nameScore('', 'Pikachu')).toBe(0);
  });
});

describe('matching rows to placeholders', () => {
  it('finds the one placeholder with that name and number', () => {
    const cards = [ph('a', 'Bulbasaur', '001/165'), ph('b', 'Ivysaur', '002/165')];
    expect(match([{ name: 'ivysaur', number: '2' }], cards)).toEqual([{ status: 'match', cardId: 'b', printings: [expect.objectContaining({ free: 1 })], pick: printingKey(cards[1]) }]);
  });

  it('ignores blank rows and asks for both the name and number', () => {
    const cards = [ph('a', 'Bulbasaur', '001/165')];
    expect(match([{ name: '', number: '' }, { name: 'Bulbasaur' }, { number: '1' }], cards).map(r => r.status)).toEqual(['blank', 'incomplete', 'incomplete']);
    // a price typed on its own isn't ignored: the row still needs its card
    expect(match([{ name: ' ', number: '', price: '4.50' }], cards).map(r => r.status)).toEqual(['incomplete']);
  });

  it('flags a card with no placeholder, and says when it is already owned', () => {
    const cards = [ph('a', 'Bulbasaur', '001/165'), { id: 'b', name: 'Ivysaur', number: '002/165' }];
    const r = match([{ name: 'Mew', number: '151' }, { name: 'Ivysaur', number: '2' }], cards);
    expect(r).toEqual([{ status: 'none', reason: 'missing' }, { status: 'none', reason: 'owned' }]);
  });

  it('never fills a sold or traded card', () => {
    const cards = [ph('a', 'Mew ex', '151/165', { status: 'sold' }), ph('b', 'Mew ex', '151/165', { status: 'traded' })];
    expect(match([{ name: 'Mew ex', number: '151' }], cards)).toEqual([{ status: 'none', reason: 'missing' }]);
  });

  it('prefers the exact name to a longer one', () => {
    const cards = [ph('a', 'Pikachu ex', '25'), ph('b', 'Pikachu', '25', { set: 'Other', setCode: 'OTH' })];
    expect(match([{ name: 'pikachu', number: '25' }], cards)[0].cardId).toBe('b');
    expect(match([{ name: 'pikachu ex', number: '25' }], cards)[0].cardId).toBe('a');
  });

  it('takes the first free pocket of one printing without asking', () => {
    const cards = [ph('late', 'Abra', '63/165', { slot: 9 }), ph('early', 'Abra', '063/165', { slot: 2 })];
    expect(match([{ name: 'abra', number: '63' }], cards, order)[0]).toMatchObject({ status: 'match', cardId: 'early' });
  });

  it('gives two copies of a card two different placeholders, then flags the third', () => {
    const cards = [ph('a', 'Abra', '63', { slot: 1 }), ph('b', 'Abra', '63', { slot: 2 })];
    const r = match([{ name: 'Abra', number: '63' }, { name: 'Abra', number: '63' }, { name: 'Abra', number: '63' }], cards, order);
    expect(r.map(x => x.cardId ?? x.reason)).toEqual(['a', 'b', 'taken']);
  });

  it('asks which printing when several fit, and keeps the one picked', () => {
    const cards = [ph('reg', 'Abra', '63'), ph('rev', 'Abra', '63', { variant: 'Reverse Holo' }), ph('ball', 'Abra', '63', { variant: 'Poke Ball' })];
    const [r] = match([{ name: 'Abra', number: '63' }], cards);
    expect(r.status).toBe('choose');
    expect(r.printings?.map(p => p.card.id)).toEqual(['reg', 'rev', 'ball']);
    const pick = r.printings![1].key;
    expect(match([{ name: 'Abra', number: '63', pick }], cards)[0]).toMatchObject({ status: 'match', cardId: 'rev', pick });
  });

  it('offers only the printings still free, and asks again when the one picked is gone', () => {
    const cards = [ph('reg', 'Abra', '63'), ph('rev', 'Abra', '63', { variant: 'Reverse Holo' }), ph('ball', 'Abra', '63', { variant: 'Poke Ball' })];
    const rev = printingKey(cards[1]);
    const r = match([{ name: 'Abra', number: '63', pick: rev }, { name: 'Abra', number: '63', pick: rev }], cards);
    expect(r[0]).toMatchObject({ status: 'match', cardId: 'rev' });
    expect(r[1].status).toBe('choose');
    expect(r[1].printings?.map(p => p.card.id)).toEqual(['reg', 'ball']);
    // with one printing left, it's taken without asking
    const r2 = match([{ name: 'Abra', number: '63', pick: rev }, { name: 'Abra', number: '63', pick: printingKey(cards[0]) }, { name: 'Abra', number: '63' }], cards);
    expect(r2.map(x => x.cardId)).toEqual(['rev', 'reg', 'ball']);
  });

  it('sees the cards as they are now: a new list of cards is looked through again', () => {
    const cards = [ph('a', 'Abra', '63')];
    expect(match([{ name: 'Abra', number: '63' }], cards)[0].cardId).toBe('a');
    const next = [{ ...cards[0], placeholder: false }, ph('b', 'Abra', '63')];
    expect(match([{ name: 'Abra', number: '63' }], next)[0].cardId).toBe('b');
  });

  it('tells the same number in two sets apart by its set size', () => {
    const cards = [ph('mew', 'Charmander', '4/165'), ph('base', 'Charmander', '4/102', { set: 'Base Set', setCode: 'BS' })];
    expect(match([{ name: 'Charmander', number: '4' }], cards)[0].status).toBe('choose');
    expect(match([{ name: 'Charmander', number: '4/102' }], cards)[0].cardId).toBe('base');
  });
});

describe('allocating tax', () => {
  it('splits it in proportion to the prices', () => {
    expect(allocate(1.5, [10, 20])).toEqual([0.5, 1]);
    expect(allocate(12, [100, 50, 50])).toEqual([6, 3, 3]);
  });

  it('always adds up to the tax to the cent', () => {
    for (const tax of [0.01, 1.3, 2.99, 13.13, 77.77]) {
      for (const prices of [[3.33, 3.33, 3.34], [1, 2, 3, 4, 5, 6, 7], [0.25, 199.99], [12.5, null, 7]]) {
        expect(sum(allocate(tax, prices))).toBe(tax);
      }
    }
  });

  it('gives a card without a price no tax', () => {
    expect(allocate(1, [null, 10, 0])).toEqual([0, 1, 0]);
  });

  it('splits evenly when no card has a price, and returns zeros with no tax', () => {
    expect(allocate(1, [null, null, null])).toEqual([0.34, 0.33, 0.33]);
    // cards priced at 0 share it; a card with no price still takes none
    expect(allocate(1, [0, 0, null])).toEqual([0.5, 0.5, 0]);
    expect(allocate(0, [5, 6])).toEqual([0, 0]);
    expect(allocate(5, [])).toEqual([]);
  });
});

describe('what a card cost', () => {
  it('adds its price and tax share to the cent', () => {
    expect(cost(10, 1.19)).toBe(11.19);
    expect(cost(0.1, 0.2)).toBe(0.3);
    expect(cost(4, 0)).toBe(4);
  });

  it('adds up to the subtotal and tax across a purchase', () => {
    const prices = [10, 4, 4, 6, 3, 20, 0.99];
    const shares = allocate(6.1, prices);
    expect(sum(prices.map((p, i) => cost(p, shares[i])))).toBe(Math.round((sum(prices) + 6.1) * 100) / 100);
  });
});
