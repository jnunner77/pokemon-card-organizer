import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placeCards, type Placement } from '#domain/ledger/place.ts';
import { AT, binder, card, value } from '../fixtures.ts';

const binders = [binder('b1', { pockets: 9 }), binder('b2', { pockets: 4 }), binder('case', { name: 'Shelf', kind: 'case' })];
// x is a Lapras; y and z are other cards, so they can't share a pocket with it.
const cards = () => [card('x', { binderId: 'b1', page: 1, slot: 1 }), card('y', { name: 'Pikachu', number: '58/102', binderId: 'b1', page: 1, slot: 2 }), card('z', { name: 'Charizard', number: '4/102', binderId: 'b2', page: 1, slot: 1 })];
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
    assert.deepEqual(placeCards([to('x', 'b2', 1, 1)], list, binders, AT), refused('POCKET_HOLDS_ANOTHER_CARD', { name: 'Charizard' }));
    assert.deepEqual(placeCards([to('x', 'b2', 1, 2), to('y', 'b2', 1, 2)], list, binders, AT), refused('POCKET_HOLDS_ANOTHER_CARD', { name: 'Lapras' }));
    assert.deepEqual(list.map((c) => c.place), cards().map((c) => c.place));
  });

  it('puts a copy in a pocket with the copies of the same card there', () => {
    const list = [...cards(), card('copy', { binderId: 'b2', page: 1, slot: 1, name: 'Charizard', number: '004/102', condition: 'LP', owner: 'Megan' })];
    const moved = value(placeCards([to('x', 'b2', 1, 2), to('copy', 'b1', 1, 3)], list, binders, AT));
    assert.deepEqual(moved.map((c) => c.id), ['x', 'copy']);
    const joined = [card('a', { binderId: 'b1', page: 1, slot: 1 }), card('b', { binderId: 'b2', page: 1, slot: 1 })];
    value(placeCards([to('b', 'b1', 1, 1)], joined, binders, AT));
    assert.deepEqual(joined.map((c) => c.place), [{ binderId: 'b1', page: 1, slot: 1 }, { binderId: 'b1', page: 1, slot: 1 }]);
  });

  it('puts two copies of one card in an empty pocket in one batch, but not two different cards', () => {
    const list = [card('a', { binderId: 'b1', page: 1, slot: 1 }), card('b', { binderId: 'b1', page: 1, slot: 2 }), card('c', { name: 'Eevee', binderId: 'b1', page: 1, slot: 3 })];
    value(placeCards([to('a', 'b2', 1, 4), to('b', 'b2', 1, 4)], list, binders, AT));
    assert.deepEqual(list.slice(0, 2).map((c) => c.place.slot), [4, 4]);
    const refusal = placeCards([to('a', 'b2', 1, 3), to('c', 'b2', 1, 3)], [card('a', { binderId: 'b1', page: 1, slot: 1 }), card('c', { name: 'Eevee', binderId: 'b1', page: 1, slot: 3 })], binders, AT);
    assert.deepEqual(refusal, refused('POCKET_HOLDS_ANOTHER_CARD', { name: 'Lapras' }));
  });

  it('swaps whole pockets in one batch', () => {
    const list = [
      card('a1', { binderId: 'b1', page: 1, slot: 1 }),
      card('a2', { binderId: 'b1', page: 1, slot: 1 }),
      card('p1', { name: 'Pikachu', number: '58/102', binderId: 'b1', page: 1, slot: 2 }),
      card('p2', { name: 'Pikachu', number: '58/102', binderId: 'b1', page: 1, slot: 2 }),
    ];
    value(placeCards([to('a1', 'b1', 1, 2), to('a2', 'b1', 1, 2), to('p1', 'b1', 1, 1), to('p2', 'b1', 1, 1)], list, binders, AT));
    assert.deepEqual(list.map((c) => c.place.slot), [2, 2, 1, 1]);
  });

  it('refuses a different card when only some of the pocket moves away', () => {
    const list = [card('a1', { binderId: 'b1', page: 1, slot: 1 }), card('a2', { binderId: 'b1', page: 1, slot: 1 }), card('p', { name: 'Pikachu', number: '58/102', binderId: 'b1', page: 1, slot: 2 })];
    assert.deepEqual(placeCards([to('a1', 'b1', 1, 2)], list, binders, AT), refused('POCKET_HOLDS_ANOTHER_CARD', { name: 'Pikachu' }));
    assert.deepEqual(placeCards([to('p', 'b1', 1, 1)], list, binders, AT), refused('POCKET_HOLDS_ANOTHER_CARD', { name: 'Lapras' }));
    assert.deepEqual(list.map((c) => c.place.slot), [1, 1, 2]);
  });
});
