import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArrangeBinder } from '#application/ledger/arrange-binder.ts';
import { card, NOW, setUp } from '../fixtures.ts';

const seeded = () => {
  const s = setUp();
  s.ledger.seed('binders', 'b1', { name: 'Trainers', pockets: 4 });
  s.ledger.seed('cards', 'x', card({ page: 1, slot: 1 }));
  s.ledger.seed('cards', 'y', card({ page: 1, slot: 3 }));
  s.ledger.seed('cards', 'elsewhere', card({ binderId: 'b2', page: 1, slot: 1 }));
  return s;
};

describe('ArrangeBinder', () => {
  it('moves the cards, saves the layout, and logs who sorted it', async () => {
    const { ledger, deps, published, logged } = seeded();
    const r = await new ArrangeBinder(deps).execute({ actor: 'justin', binderId: 'b1', moves: [{ cardId: 'y', page: 1, slot: 1 }, { cardId: 'x', page: 1, slot: 2 }], saveLayout: true });
    assert.deepEqual(r, { ok: true, value: { moved: 2, cards: 2, layoutSaved: 2 } });
    assert.deepEqual([ledger.tables.cards.get('y')?.['slot'], ledger.tables.cards.get('x')?.['slot']], [1, 2]);
    assert.equal(ledger.tables.cards.get('x')?.['updatedAt'], NOW.toISOString());
    assert.deepEqual(ledger.tables.binders.get('b1')?.['layout'], { savedAt: NOW.toISOString(), places: [{ id: 'x', page: 1, slot: 1 }, { id: 'y', page: 1, slot: 3 }] });
    assert.deepEqual(published.map((e) => e.id), ['y', 'x', 'b1']);
    assert.deepEqual(logged, ['justin sorted Trainers: 2 of 2 cards moved, layout saved']);
  });

  it('does not touch the binder without saveLayout', async () => {
    const { ledger, deps, logged } = seeded();
    await new ArrangeBinder(deps).execute({ actor: 'justin', binderId: 'b1', moves: [{ cardId: 'x', page: 1, slot: 1 }, { cardId: 'y', page: 1, slot: 2 }], saveLayout: false });
    assert.equal(ledger.tables.binders.get('b1')?.['layout'], undefined);
    assert.deepEqual(logged, ['justin sorted Trainers: 1 of 2 cards moved']);
  });

  it('refuses a binder that is gone or changed, saving and logging nothing', async () => {
    const { ledger, deps, published, logged } = seeded();
    const arrange = new ArrangeBinder(deps);
    assert.deepEqual(await arrange.execute({ actor: 'j', binderId: 'gone', moves: [], saveLayout: false }), { ok: false, error: { code: 'BINDER_NOT_FOUND' } });
    assert.deepEqual(await arrange.execute({ actor: 'j', binderId: 'bad id', moves: [], saveLayout: false }), { ok: false, error: { code: 'BINDER_NOT_FOUND' } });
    assert.deepEqual(await arrange.execute({ actor: 'j', binderId: 'b1', moves: [{ cardId: 'x', page: 2, slot: 1 }], saveLayout: true }), { ok: false, error: { code: 'BINDER_CHANGED' } });
    assert.equal(ledger.tables.cards.get('x')?.['page'], 1);
    assert.equal(ledger.tables.binders.get('b1')?.['layout'], undefined);
    assert.deepEqual([published, logged], [[], []]);
  });
});
