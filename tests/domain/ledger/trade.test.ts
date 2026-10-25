import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Card } from '#domain/cards/card.ts';
import { type ReceivedCard, recordTrade, type TradeRecord, undoTrade } from '#domain/ledger/trade.ts';
import { AT, binder, card, value } from '../fixtures.ts';

const binders = [binder('b1', { pockets: 4 }), binder('case', { name: 'Shelf', kind: 'case' })];
const cards = () => [
  card('mine', { binderId: 'b1', page: 1, slot: 1 }),
  card('other', { binderId: 'b1', page: 1, slot: 2 }),
  card('ph', { name: 'Charizard', binderId: 'b1', page: 2, slot: 3, placeholder: true, grader: 'Raw', grade: '', prices: [{ id: 'm1', type: 'market', amount: 300, currency: 'CAD' }] }),
  card('sold', { status: 'sold', binderId: null, page: null, slot: null }),
];
const given = (cardId: string) => ({ cardId, sale: { amount: 40, currency: 'CAD', soldCAD: 40, cost: 21.2, basis: 'market', profit: 18.8, date: '2026-10-25', where: 'Trade', trade: { gaveCash: 0, gotCash: 10 } }, entry: { id: `s-${cardId}`, type: 'mysale', amount: 40, currency: 'CAD', date: '2026-10-25', where: 'Trade' } });
const paid = (id: string) => [{ id, type: 'paid', amount: 30, currency: 'CAD', date: '2026-10-25', where: 'Trade' }];
const fresh = (cardId: string, binderId: string | null): ReceivedCard => ({ kind: 'new', cardId, binderId, doc: { name: 'Mew', set: 'Base', number: '8/102', grader: 'PSA', grade: '9', id: 'ignored', prices: [{ id: 'x' }] }, entries: paid(`p-${cardId}`) });
const fill = (cardId: string): ReceivedCard => ({ kind: 'placeholder', cardId, grader: 'PSA', grade: '10', entries: paid(`p-${cardId}`) });
const trade = (over: Partial<TradeRecord> = {}): TradeRecord => ({ tradeId: 't1', given: [given('mine')], received: [fresh('n1', 'b1')], ...over });
const byId = (list: readonly Card[], id: string) => list.find((c) => c.id === id);
const refused = (code: string, extra: Record<string, unknown> = {}) => ({ ok: false, error: { code, ...extra } });

describe('recording a trade', () => {
  it('trades my cards away with their sale, from where they were', () => {
    const list = cards();
    const { saved } = value(recordTrade(trade(), list, binders, AT));
    const mine = byId(saved, 'mine');
    assert.equal(mine?.fields['status'], 'traded');
    assert.deepEqual(mine?.place, { binderId: null, page: null, slot: null });
    assert.deepEqual(mine?.fields['sale'], { ...given('mine').sale, priceId: 's-mine', from: { binderId: 'b1', page: 1, slot: 1 }, trade: { gaveCash: 0, gotCash: 10, id: 't1' } });
    assert.deepEqual((mine?.fields['prices'] as unknown[]).at(-1), given('mine').entry);
  });

  it('adds the cards I get in the next free pocket nobody was in, a case, or no binder', () => {
    const list = cards();
    const { saved } = value(recordTrade(trade({ received: [fresh('n1', 'b1'), fresh('n2', 'b1'), fresh('n3', 'case'), fresh('n4', null)] }), list, binders, AT));
    // The pocket my traded card leaves (1/1) stays empty; 1/3 and 1/4 are free.
    assert.deepEqual(['n1', 'n2', 'n3', 'n4'].map((id) => byId(saved, id)?.place), [
      { binderId: 'b1', page: 1, slot: 3 },
      { binderId: 'b1', page: 1, slot: 4 },
      { binderId: 'case', page: null, slot: null },
      { binderId: null, page: null, slot: null },
    ]);
    const n1 = byId(saved, 'n1');
    assert.deepEqual([n1?.fields['name'], n1?.fields['grader'], n1?.fields['status'], n1?.fields['placeholder'], n1?.fields['trade']], ['Mew', 'PSA', 'binder', false, { id: 't1', filled: false }]);
    assert.deepEqual(n1?.fields['prices'], paid('p-n1'));
    assert.equal(n1?.fields['createdAt'], AT.toISOString());
  });

  it('goes on to the next page when the binder is full', () => {
    const full = [card('a', { slot: 1 }), card('b', { slot: 2 }), card('c', { slot: 3 }), card('d', { slot: 4 })];
    const { saved } = value(recordTrade(trade({ given: [] }), full, binders, AT));
    assert.deepEqual(byId(saved, 'n1')?.place, { binderId: 'b1', page: 2, slot: 1 });
  });

  it('fills a placeholder: it becomes my card, priced, keeping its pocket and what it was', () => {
    const list = cards();
    const { saved } = value(recordTrade(trade({ given: [], received: [fill('ph')] }), list, binders, AT));
    const ph = byId(saved, 'ph');
    assert.deepEqual([ph?.fields['placeholder'], ph?.fields['grader'], ph?.fields['grade'], ph?.place], [false, 'PSA', '10', { binderId: 'b1', page: 2, slot: 3 }]);
    assert.deepEqual(ph?.fields['trade'], { id: 't1', filled: true, was: { grader: 'Raw', grade: '' }, entryIds: ['p-ph'] });
    assert.equal((ph?.fields['prices'] as unknown[]).length, 2);
  });

  it('refuses each kind of bad trade, changing nothing', () => {
    const list = cards();
    const before = list.map((c) => c.fields);
    assert.deepEqual(recordTrade(trade({ given: [], received: [] }), list, binders, AT), refused('NOTHING_TO_RECORD'));
    assert.deepEqual(recordTrade(trade({ given: [given('mine'), given('mine')] }), list, binders, AT), refused('CARD_GIVEN_TWICE'));
    assert.deepEqual(recordTrade(trade({ given: [given('gone')] }), list, binders, AT), refused('CARD_DELETED_MEANWHILE'));
    assert.deepEqual(recordTrade(trade({ given: [given('sold')] }), list, binders, AT), refused('CARD_NOT_HELD', { name: 'Lapras' }));
    assert.deepEqual(recordTrade(trade({ given: [given('ph')] }), list, binders, AT), refused('CARD_NOT_HELD', { name: 'Charizard' }));
    assert.deepEqual(recordTrade(trade({ received: [fill('other')] }), list, binders, AT), refused('NOT_A_PLACEHOLDER', { name: 'Lapras' }));
    assert.deepEqual(recordTrade(trade({ received: [fresh('other', null)] }), list, binders, AT), refused('CARD_ID_TAKEN'));
    assert.deepEqual(recordTrade(trade({ received: [fresh('n1', 'nope')] }), list, binders, AT), refused('BINDER_GONE'));
    assert.deepEqual(recordTrade(trade({ received: [fresh('bad id', null)] }), list, binders, AT), refused('INVALID_ID', { id: 'bad id' }));
    assert.deepEqual(list.map((c) => c.fields), before);
  });
});

describe('a trade with a card that can’t be saved', () => {
  it('is refused with what is wrong', () => {
    const r = recordTrade(trade({ received: [{ ...fresh('n1', null), doc: { name: 5 } } as ReceivedCard] }), cards(), binders, AT);
    assert.deepEqual(r, refused('INVALID_DOCUMENT', { message: 'name: Expected text' }));
  });
});

describe('undoing a trade', () => {
  const recorded = (received: ReceivedCard[] = [fresh('n1', 'b1'), fill('ph')]) => {
    const list = cards();
    const { saved } = value(recordTrade(trade({ received }), list, binders, AT));
    const ids = new Set(saved.map((c) => String(c.id)));
    return [...list.filter((c) => !ids.has(String(c.id))), ...saved];
  };

  it('brings my cards back where they were, deletes the added cards and puts the placeholders back', () => {
    const list = recorded();
    const { saved, deleted } = value(undoTrade('t1', list, binders, AT));
    assert.deepEqual(deleted.map((c) => c.id), ['n1']);
    const mine = byId(saved, 'mine');
    assert.deepEqual([mine?.fields['status'], mine?.fields['sale'], mine?.place], ['binder', null, { binderId: 'b1', page: 1, slot: 1 }]);
    assert.ok(!(mine?.fields['prices'] as { id: string }[]).some((p) => p.id === 's-mine'));
    const ph = byId(saved, 'ph');
    assert.deepEqual([ph?.fields['placeholder'], ph?.fields['grader'], ph?.fields['grade'], ph?.fields['trade']], [true, 'Raw', '', null]);
    assert.deepEqual(ph?.fields['prices'], [{ id: 'm1', type: 'market', amount: 300, currency: 'CAD' }]);
  });

  it('puts my card in the next free pocket when another card took its old one', () => {
    const list = recorded([]);
    const taken = [...list, card('newcomer', { binderId: 'b1', page: 1, slot: 1 })];
    const { saved } = value(undoTrade('t1', taken, binders, AT));
    assert.deepEqual(byId(saved, 'mine')?.place, { binderId: 'b1', page: 1, slot: 3 });
  });

  it('puts my card under no binder when its binder is gone, and says when there is no such trade', () => {
    const list = recorded([]);
    assert.deepEqual(byId(value(undoTrade('t1', list, [], AT)).saved, 'mine')?.place, { binderId: null, page: null, slot: null });
    assert.deepEqual(undoTrade('t2', list, binders, AT), refused('TRADE_NOT_FOUND'));
  });
});
