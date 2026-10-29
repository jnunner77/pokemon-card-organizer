import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pocketKey, pocketRefusal } from '#domain/ledger/pockets.ts';
import { card } from '../fixtures.ts';

const at = (binderId: string | null, page: number | null, slot: number | null) => ({ binderId, page, slot });
const pikachu = (id: string, place = at('b1', 1, 1), over: Record<string, unknown> = {}) => card(id, { name: 'Pikachu', number: '58/102', ...place, ...over });

describe('a pocket holds copies of one card', () => {
  it('names a pocket only for a binder, page and pocket', () => {
    assert.equal(pocketKey(at('b1', 2, 3)), 'b1/2/3');
    assert.equal(pocketKey(at('b1', null, null)), null);
    assert.equal(pocketKey(at(null, 1, 1)), null);
  });

  it('accepts an empty pocket, a stack of the same card, and itself', () => {
    const mine = pikachu('a');
    assert.equal(pocketRefusal(mine, []), null);
    assert.equal(pocketRefusal(mine, [mine]), null);
    assert.equal(pocketRefusal(mine, [pikachu('b', at('b1', 1, 1), { condition: 'LP', owner: 'Megan' }), pikachu('c')]), null);
  });

  it('ignores other pockets, other binders, cases and loose cards', () => {
    const mine = pikachu('a');
    assert.equal(pocketRefusal(mine, [card('d', { name: 'Charizard', binderId: 'b1', page: 1, slot: 2 }), card('e', { name: 'Charizard', binderId: 'b2', page: 1, slot: 1 })]), null);
    assert.equal(pocketRefusal(pikachu('f', at('case', null, null)), [card('g', { name: 'Charizard', binderId: 'case', page: null, slot: null })]), null);
    assert.equal(pocketRefusal(pikachu('h', at(null, null, null)), [card('i', { name: 'Charizard', binderId: null, page: null, slot: null })]), null);
  });

  it('names the different card in the pocket', () => {
    const mine = pikachu('a');
    assert.deepEqual(pocketRefusal(mine, [pikachu('b'), card('c', { name: 'Charizard', number: '4/102', binderId: 'b1', page: 1, slot: 1 })]), { code: 'POCKET_HOLDS_ANOTHER_CARD', name: 'Charizard' });
  });
});
