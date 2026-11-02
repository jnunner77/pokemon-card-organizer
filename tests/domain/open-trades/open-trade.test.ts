import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkOpenTradeContent,
  discardOpenTrade,
  type OpenTradeBook,
  type OpenTradeContent,
  type OpenTradeId,
  openTradeBookFrom,
  saveOpenTrade,
} from '#domain/open-trades/open-trade.ts';

const id = (s: string): OpenTradeId => s as OpenTradeId;
const content = (customer = ''): OpenTradeContent => ({ customer, dealer: { pct: '100', cash: '', items: [] }, mine: { pct: '100', cash: '', items: [] } });
const at = '2026-10-05T18:00:00.000Z';
const save = (book: OpenTradeBook, name: string, baseVersion = 0, c = content()) => saveOpenTrade(book, { id: id(name), baseVersion, content: c, by: 'justin', at });

describe('checking an open trade', () => {
  it('fills in defaults and trims the customer', () => {
    const r = checkOpenTradeContent({ customer: '  Ash  ' });
    assert.ok(r.ok);
    assert.deepEqual(r.value, { customer: 'Ash', dealer: { pct: '100', cash: '', items: [] }, mine: { pct: '100', cash: '', items: [] } });
  });
  it('refuses what is wrong', () => {
    const bad = (raw: unknown) => assert.equal(checkOpenTradeContent(raw).ok, false);
    bad('x');
    bad({ customer: 'x'.repeat(41) });
    bad({ customer: 5 });
    bad({ dealer: 'x' });
    bad({ dealer: { items: ['x'] } });
    bad({ dealer: { items: Array.from({ length: 101 }, () => ({})) } });
    bad({ dealer: { items: [{ big: 'x'.repeat(300_000) }] } });
  });
  it('keeps unknown item fields', () => {
    const r = checkOpenTradeContent({ mine: { items: [{ cardId: 'a', extra: [1] }] } });
    assert.ok(r.ok);
    assert.deepEqual(r.value.mine.items, [{ cardId: 'a', extra: [1] }]);
  });
});

describe('saving open trades', () => {
  it('numbers trades from the lowest free number', () => {
    const book: OpenTradeBook = { trades: [] };
    for (const n of ['a', 'b', 'c']) save(book, n);
    assert.deepEqual(book.trades.map((t) => t.number), [1, 2, 3]);
    assert.ok(discardOpenTrade(book, id('b')));
    save(book, 'd');
    assert.equal(book.trades.find((t) => t.id === 'd')?.number, 2);
  });
  it('refuses an 11th', () => {
    const book: OpenTradeBook = { trades: [] };
    for (let i = 0; i < 10; i++) assert.ok(save(book, `t${i}`).ok);
    const r = save(book, 'extra');
    assert.deepEqual(!r.ok && r.error.code, 'TOO_MANY_OPEN_TRADES');
    assert.equal(book.trades.length, 10);
  });
  it('raises the version on the right base and refuses a stale one', () => {
    const book: OpenTradeBook = { trades: [] };
    save(book, 'a');
    const r = save(book, 'a', 1, content('Ash'));
    assert.ok(r.ok && r.value.trade.version === 2 && r.value.changed && !r.value.created);
    const stale = save(book, 'a', 1, content('Misty'));
    assert.deepEqual(!stale.ok && stale.error, { code: 'OPEN_TRADE_CHANGED', version: 2 });
    assert.equal(book.trades[0]?.customer, 'Ash');
  });
  it('says a trade is closed when it is gone but a version was expected', () => {
    const r = save({ trades: [] }, 'a', 3);
    assert.deepEqual(!r.ok && r.error.code, 'OPEN_TRADE_CLOSED');
  });
  it('changes nothing when the content is the same', () => {
    const book: OpenTradeBook = { trades: [] };
    save(book, 'a');
    const r = save(book, 'a', 1);
    assert.ok(r.ok && !r.value.changed && r.value.trade.version === 1);
  });
  it('discards a trade or finds it gone', () => {
    const book: OpenTradeBook = { trades: [] };
    save(book, 'a');
    assert.equal(discardOpenTrade(book, id('a'))?.number, 1);
    assert.equal(discardOpenTrade(book, id('a')), null);
  });
});

describe('loading open trades', () => {
  it('drops broken entries and repeated ids or numbers', () => {
    const good = (idv: string, number: number) => ({ id: idv, number, version: 1, createdAt: at, updatedAt: at, updatedBy: 'j', ...content() });
    const book = openTradeBookFrom({
      trades: [good('a', 1), good('a', 2), good('b', 1), good('c', 11), { ...good('d', 3), version: 0 }, 'x', { ...good('e', 4), customer: 'x'.repeat(50) }, good('f', 5)],
    });
    assert.deepEqual(book.trades.map((t) => t.id), ['a', 'f']);
    assert.deepEqual(openTradeBookFrom(null).trades, []);
  });
});
