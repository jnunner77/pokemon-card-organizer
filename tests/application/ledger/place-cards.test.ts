import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlaceCards } from '#application/ledger/place-cards.ts';
import { card, setUp } from '../fixtures.ts';

describe('PlaceCards', () => {
  it('moves the cards and logs it', async () => {
    const { ledger, deps, logged } = setUp();
    ledger.seed('binders', 'b1', { name: 'One' });
    ledger.seed('binders', 'b2', { name: 'Two' });
    ledger.seed('cards', 'x', card());
    const r = await new PlaceCards(deps).execute({ actor: 'megan', placements: [{ cardId: 'x', binderId: 'b2', page: 3, slot: 4 }] });
    assert.deepEqual(r, { ok: true, value: { moved: 1 } });
    assert.deepEqual([ledger.tables.cards.get('x')?.['binderId'], ledger.tables.cards.get('x')?.['page']], ['b2', 3]);
    assert.deepEqual(logged, ['megan moved 1 card']);
  });

  it('refuses a pocket filled meanwhile, saving and logging nothing', async () => {
    const { ledger, deps, logged, published } = setUp();
    ledger.seed('binders', 'b1', { name: 'One' });
    ledger.seed('cards', 'x', card({ slot: 1 }));
    ledger.seed('cards', 'y', card({ slot: 2 }));
    const r = await new PlaceCards(deps).execute({ actor: 'megan', placements: [{ cardId: 'x', binderId: 'b1', page: 1, slot: 2 }] });
    assert.deepEqual(r, { ok: false, error: { code: 'POCKET_TAKEN' } });
    assert.equal(ledger.tables.cards.get('x')?.['slot'], 1);
    assert.deepEqual([logged, published], [[], []]);
  });
});
