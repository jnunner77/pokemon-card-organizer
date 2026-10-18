import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placeCards, type Placement } from '#domain/ledger/place.ts';
import { AT, binder, card, value } from '../fixtures.ts';

const binders = [binder('b1', { pockets: 9 }), binder('b2', { pockets: 4 }), binder('case', { name: 'Shelf', kind: 'case' })];
const cards = () => [card('x', { binderId: 'b1', page: 1, slot: 1 }), card('y', { binderId: 'b1', page: 1, slot: 2 }), card('z', { binderId: 'b2', page: 1, slot: 1 })];
const to = (cardId: string, binderId: string | null, page: number | null, slot: number | null): Placement => ({ cardId, binderId, page, slot });
const refused = (code: string, extra: Record<string, unknown> = {}) => ({ ok: false, error: { code, ...extra } });

describe('moving cards', () => {
  it('moves them all at once; a card already there is not a move', () => {
    const list = cards();
    const moved = value(placeCards([to('x', 'b2', 1, 2), to('y', 'b1', 1, 2)], list, binders, AT));
    assert.deepEqual(moved.map((c) => c.id), ['x']);
    assert.deepEqual(list[0]?.place, { binderId: 'b2', page: 1, slot: 2 });
    assert.equal(list[0]?.fields['updatedAt'], AT.toISOString());
  });

  it('puts cards in a display case, or nowhere, with no page or pocket', () => {
    const list = cards();
    value(placeCards([to('x', 'case', null, null), to('y', null, null, null)], list, binders, AT));
    assert.deepEqual(list.slice(0, 2).map((c) => c.place), [{ binderId: 'case', page: null, slot: null }, { binderId: null, page: null, slot: null }]);
  });

  it('lets cards swap pockets: the ones moving away free theirs', () => {
    const list = cards();
    value(placeCards([to('x', 'b1', 1, 2), to('y', 'b1', 1, 1)], list, binders, AT));
    assert.deepEqual(list.slice(0, 2).map((c) => c.place.slot), [2, 1]);
  });

  it('refuses each kind of bad move, moving nothing', () => {
    const list = cards();
    assert.deepEqual(placeCards([to('x', 'b2', 1, 2), to('x', 'b2', 1, 3)], list, binders, AT), refused('CARD_GIVEN_TWICE'));
    assert.deepEqual(placeCards([to('gone', 'b2', 1, 2)], list, binders, AT), refused('CARD_DELETED_MEANWHILE'));
    assert.deepEqual(placeCards([to('x', 'nope', 1, 2)], list, binders, AT), refused('BINDER_GONE'));
    assert.deepEqual(placeCards([to('x', 'case', 1, 1)], list, binders, AT), refused('CASE_HAS_NO_POCKETS', { binderName: 'Shelf' }));
    assert.deepEqual(placeCards([to('x', 'b2', null, null)], list, binders, AT), refused('POCKET_REQUIRED'));
    assert.deepEqual(placeCards([to('x', 'b2', 1, 5)], list, binders, AT), refused('POCKET_PAST_PAGE'));
    assert.deepEqual(placeCards([to('x', 'b2', 1, 1)], list, binders, AT), refused('POCKET_TAKEN'));
    assert.deepEqual(placeCards([to('x', 'b2', 1, 2), to('y', 'b2', 1, 2)], list, binders, AT), refused('POCKET_TAKEN'));
    assert.deepEqual(list.map((c) => c.place), cards().map((c) => c.place));
  });
});
