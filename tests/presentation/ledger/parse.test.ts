import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arrangement, placements, priceChange } from '#presentation/ledger/parse.ts';

describe('ledger request bodies', () => {
  it('price changes: add, update, remove and fields, nothing else', () => {
    assert.deepEqual(priceChange({ add: [{ id: 'a', amount: 1 }], remove: ['b'], fields: { status: 'sold' } }), { add: [{ id: 'a', amount: 1 }], update: undefined, remove: ['b'], fields: { status: 'sold' } });
    assert.deepEqual(priceChange({}), { add: undefined, update: undefined, remove: undefined, fields: undefined });
    for (const bad of [null, [], { other: 1 }, { add: [{ amount: 1 }] }, { add: [{ id: '' }] }, { remove: [''] }, { remove: 'a' }, { fields: [] }, { add: Array(2001).fill({ id: 'a' }) }]) {
      assert.equal(priceChange(bad), null, JSON.stringify(bad).slice(0, 60));
    }
  });

  it('sorting: each card with its page and pocket', () => {
    assert.deepEqual(arrangement({ moves: [{ id: 'c1', page: 1, slot: 2, extra: true }], saveLayout: true }), { moves: [{ cardId: 'c1', page: 1, slot: 2 }], saveLayout: true });
    assert.deepEqual(arrangement({ moves: [] }), { moves: [], saveLayout: false });
    for (const bad of [{}, { moves: [{ id: 'c1', page: 0, slot: 1 }] }, { moves: [{ id: 'c1', page: 1, slot: 65 }] }, { moves: [{ id: 'bad id', page: 1, slot: 1 }] }, { moves: [], saveLayout: 'yes' }]) {
      assert.equal(arrangement(bad), null, JSON.stringify(bad));
    }
  });

  it('moving: a binder, page and pocket, or a blank page and pocket; at least one card', () => {
    assert.deepEqual(placements({ moves: [{ id: 'c1', binderId: 'b1', page: 1, slot: 1 }, { id: 'c2', binderId: null, page: null, slot: null }, { id: 'c3', binderId: 'case', page: null, slot: null }] }), [
      { cardId: 'c1', binderId: 'b1', page: 1, slot: 1 },
      { cardId: 'c2', binderId: null, page: null, slot: null },
      { cardId: 'c3', binderId: 'case', page: null, slot: null },
    ]);
    for (const bad of [{ moves: [] }, { moves: [{ id: 'c1', binderId: null, page: 1, slot: 1 }] }, { moves: [{ id: 'c1', binderId: 'b1', page: 1 }] }, { moves: [{ id: 'c1', binderId: 'b1', page: null, slot: 1 }] }, null]) {
      assert.equal(placements(bad), null, JSON.stringify(bad));
    }
  });
});
