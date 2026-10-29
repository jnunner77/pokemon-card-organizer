import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arrangeBinder } from '#domain/ledger/arrange.ts';
import { AT, binder, card, value } from '../fixtures.ts';

const setUp = () => {
  const b = binder('b1', { pockets: 4 });
  // x is a Lapras; y and z are other cards.
  const cards = [card('x', { page: 1, slot: 1 }), card('y', { name: 'Pikachu', number: '58/102', page: 1, slot: 3 }), card('z', { name: 'Charizard', number: '4/102', page: 2, slot: 1 })];
  return { b, cards };
};
const moves = (...list: [string, number, number][]) => list.map(([cardId, page, slot]) => ({ cardId, page, slot }));

describe('sorting a binder', () => {
  it('moves every card at once; the ones already in place are not moves', () => {
    const { b, cards } = setUp();
    const r = value(arrangeBinder(b, cards, moves(['z', 1, 1], ['x', 1, 2], ['y', 1, 3]), { saveLayout: false, at: AT }));
    assert.deepEqual(r.moved.map((c) => c.id), ['z', 'x']);
    assert.equal(r.layoutSaved, null);
    assert.deepEqual(cards.map((c) => c.place), [{ binderId: 'b1', page: 1, slot: 2 }, { binderId: 'b1', page: 1, slot: 3 }, { binderId: 'b1', page: 1, slot: 1 }]);
    assert.equal(b.fields['layout'], undefined);
  });

  it('keeps where the cards were on the binder when asked', () => {
    const { b, cards } = setUp();
    const r = value(arrangeBinder(b, cards, moves(['z', 1, 1], ['x', 1, 2], ['y', 1, 3]), { saveLayout: true, at: AT }));
    assert.equal(r.layoutSaved, 3);
    assert.deepEqual(b.fields['layout'], { savedAt: AT.toISOString(), places: [{ id: 'x', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 3 }, { id: 'z', page: 2, slot: 1 }] });
  });

  it('leaves out of the layout a card in no pocket the binder has', () => {
    const b = binder('b1', { pockets: 4 });
    const cards = [card('x', { page: 1, slot: 1 }), card('w', { page: 1, slot: 9 })];
    const r = value(arrangeBinder(b, cards, moves(['x', 1, 2], ['w', 1, 1]), { saveLayout: true, at: AT }));
    assert.equal(r.layoutSaved, 1);
  });

  it('refuses a display case', () => {
    const { cards } = setUp();
    assert.deepEqual(arrangeBinder(binder('b1', { kind: 'case' }), cards, [], { saveLayout: false, at: AT }), { ok: false, error: { code: 'BINDER_IS_CASE' } });
  });

  it('refuses when the binder changed meanwhile, and moves nothing', () => {
    const { b, cards } = setUp();
    const changed = { ok: false, error: { code: 'BINDER_CHANGED' } };
    assert.deepEqual(arrangeBinder(b, cards, moves(['z', 1, 1], ['x', 1, 2]), { saveLayout: false, at: AT }), changed); // y left behind
    assert.deepEqual(arrangeBinder(b, cards, moves(['z', 1, 1], ['x', 1, 2], ['y', 1, 3], ['new', 1, 4]), { saveLayout: false, at: AT }), changed);
    assert.deepEqual(arrangeBinder(b, cards, moves(['z', 1, 1], ['x', 1, 2], ['x', 1, 3]), { saveLayout: false, at: AT }), changed); // given twice
    assert.deepEqual(arrangeBinder(b, cards, moves(['z', 1, 1], ['x', 1, 2], ['other', 1, 3]), { saveLayout: false, at: AT }), changed);
    assert.deepEqual(cards.map((c) => c.place.slot), [1, 3, 1]);
  });

  it('lets copies of one card share a pocket, and keeps both places in the saved layout', () => {
    const b = binder('b1', { pockets: 4 });
    const cards = [card('x', { page: 1, slot: 1 }), card('x2', { page: 1, slot: 1, condition: 'LP' }), card('y', { name: 'Pikachu', number: '58/102', page: 1, slot: 3 })];
    const r = value(arrangeBinder(b, cards, moves(['y', 1, 1], ['x', 1, 2], ['x2', 1, 2]), { saveLayout: true, at: AT }));
    assert.deepEqual(r.moved.map((c) => c.id), ['y', 'x', 'x2']);
    assert.equal(r.layoutSaved, 3);
    assert.deepEqual(b.fields['layout'], { savedAt: AT.toISOString(), places: [{ id: 'x', page: 1, slot: 1 }, { id: 'x2', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 3 }] });
    assert.deepEqual(cards.map((c) => c.place.slot), [2, 2, 1]);
  });

  it('refuses two different cards in one pocket, or a pocket past the page', () => {
    const { b, cards } = setUp();
    assert.deepEqual(arrangeBinder(b, cards, moves(['z', 1, 1], ['x', 1, 1], ['y', 1, 3]), { saveLayout: false, at: AT }), { ok: false, error: { code: 'POCKET_SHARED' } });
    assert.deepEqual(arrangeBinder(b, cards, moves(['z', 1, 5], ['x', 1, 1], ['y', 1, 3]), { saveLayout: false, at: AT }), { ok: false, error: { code: 'POCKET_PAST_PAGE', pockets: 4 } });
    assert.equal(b.fields['layout'], undefined);
  });
});
