import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repageBinder } from '#domain/ledger/repage.ts';
import { AT, binder, card, value } from '../fixtures.ts';

const at = (page: number, slot: number) => ({ page, slot });
const places = (cards: readonly { place: { page: number | null; slot: number | null } }[]) => cards.map((c) => [c.place.page, c.place.slot]);

describe('changing a binder’s pockets per page', () => {
  it('keeps the cards in order, empty pockets too, from 9 pockets to 4', () => {
    const b = binder('b1', { pockets: 4 });
    const cards = [card('a', at(1, 1)), card('b', at(1, 4)), card('c', at(1, 5)), card('d', at(1, 9)), card('e', at(2, 1))];
    const moved = value(repageBinder(b, cards, 9, AT));
    assert.deepEqual(places(cards), [[1, 1], [1, 4], [2, 1], [3, 1], [3, 2]]);
    assert.deepEqual(moved.map((c) => c.id), ['c', 'd', 'e']);
  });

  it('keeps the order from 4 pockets to 9', () => {
    const b = binder('b1', { pockets: 9 });
    const cards = [card('a', at(1, 1)), card('b', at(2, 1)), card('c', at(3, 2)), card('d', at(4, 4))];
    value(repageBinder(b, cards, 4, AT));
    assert.deepEqual(places(cards), [[1, 1], [1, 5], [2, 1], [2, 7]]);
  });

  it('moves the saved layout the same way, keeping when it was saved', () => {
    const b = binder('b1', { pockets: 4, layout: { savedAt: '2026-01-01T00:00:00.000Z', places: [{ id: 'a', page: 1, slot: 6 }, { id: 'b', page: 2, slot: 1 }] } });
    value(repageBinder(b, [], 9, AT));
    assert.deepEqual(b.fields['layout'], { savedAt: '2026-01-01T00:00:00.000Z', places: [{ id: 'a', page: 2, slot: 2 }, { id: 'b', page: 3, slot: 2 }] });
  });

  it('puts back a binder whose cards were left past its page when its size changed before', () => {
    // A 9-pocket binder switched to 4 before cards moved with it: pockets 5–9 still say so.
    const b = binder('b1', { pockets: 4 });
    const cards = [card('a', at(1, 1)), card('b', at(1, 5)), card('c', at(1, 9)), card('d', at(2, 1)), card('e', at(6, 1))];
    value(repageBinder(b, cards, 4, AT));
    assert.deepEqual(places(cards), [[1, 1], [2, 1], [3, 1], [3, 2], [12, 2]]);
    assert.equal(new Set(places(cards).map(String)).size, cards.length);
  });

  it('changes nothing when the size is the same and every card fits', () => {
    const b = binder('b1', { pockets: 9 });
    const cards = [card('a', at(1, 9)), card('b', at(3, 2))];
    assert.deepEqual(value(repageBinder(b, cards, 9, AT)), []);
    assert.deepEqual(places(cards), [[1, 9], [3, 2]]);
    assert.deepEqual(b.pullEvents(), []);
  });

  it('leaves a display case and cards with no pocket alone', () => {
    const loose = card('a', { page: null, slot: null });
    assert.deepEqual(value(repageBinder(binder('b1', { pockets: 4 }), [loose], 9, AT)), []);
    assert.deepEqual(loose.place, { binderId: 'b1', page: null, slot: null });
    const inCase = card('b', at(1, 9));
    assert.deepEqual(value(repageBinder(binder('b1', { kind: 'case' }), [inCase], 4, AT)), []);
    assert.deepEqual(inCase.place, { binderId: 'b1', page: 1, slot: 9 });
  });
});
