import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { outOfBinderWhenSold, withSoldCardsOutOfBinders } from '#domain/cards/sold.ts';

const sold = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'Lapras', status: 'sold', binderId: 'b1', page: 1, slot: 2, ...over });

describe('a sold card is in no binder', () => {
  it('loses its pocket and remembers it as sale.from', () => {
    assert.deepEqual(outOfBinderWhenSold(sold()), { name: 'Lapras', status: 'sold', binderId: null, page: null, slot: null, sale: { from: { binderId: 'b1', page: 1, slot: 2 } } });
  });

  it('keeps the rest of an existing sale, and records the pocket it leaves over a from already there', () => {
    assert.deepEqual(outOfBinderWhenSold(sold({ sale: { soldCAD: 5 } }))['sale'], { soldCAD: 5, from: { binderId: 'b1', page: 1, slot: 2 } });
    const sale = { soldCAD: 5, from: { binderId: 'b0', page: 3, slot: 4 } };
    assert.deepEqual(outOfBinderWhenSold(sold({ sale }))['sale'], { soldCAD: 5, from: { binderId: 'b1', page: 1, slot: 2 } });
  });

  it('treats traded like sold, and a display case as a place without page or pocket', () => {
    assert.deepEqual(outOfBinderWhenSold(sold({ status: 'traded', binderId: 'case', page: null, slot: null }))['sale'], { from: { binderId: 'case', page: null, slot: null } });
  });

  it('leaves other cards, and sold cards with no place, as the same object', () => {
    for (const f of [sold({ status: 'binder' }), sold({ status: 'listed' }), sold({ status: 'grading' }), sold({ binderId: null, page: null, slot: null })]) {
      assert.equal(outOfBinderWhenSold(f), f);
    }
  });
});

describe('withSoldCardsOutOfBinders', () => {
  it('counts the cards it moved and leaves binders and settings alone', () => {
    const ledger = { binders: { b1: { name: 'One' } }, cards: { a: sold(), b: sold({ status: 'binder' }), c: sold({ status: 'traded' }) }, settings: { main: { usdToCad: 1.4 } } };
    const r = withSoldCardsOutOfBinders(ledger);
    assert.equal(r.moved, 2);
    assert.equal(r.ledger.binders, ledger.binders);
    assert.equal(r.ledger.settings, ledger.settings);
    assert.equal(r.ledger.cards['b'], ledger.cards['b']);
    assert.equal(r.ledger.cards['a']?.['binderId'], null);
    assert.equal(withSoldCardsOutOfBinders(r.ledger).moved, 0);
  });
});
