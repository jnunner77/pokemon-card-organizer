import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TakeSoldCardsOutOfBinders } from '#application/ledger/take-sold-cards-out.ts';
import { card, NOW, setUp } from '../fixtures.ts';

describe('TakeSoldCardsOutOfBinders', () => {
  it('moves only sold or traded cards that are in a binder, in one unit of work, and says so', async () => {
    const { ledger, deps, published, logged } = setUp();
    ledger.seed('cards', 'a', card({ status: 'sold', slot: 1 }));
    ledger.seed('cards', 'b', card({ status: 'traded', slot: 2 }));
    ledger.seed('cards', 'c', card({ slot: 3 }));
    ledger.seed('cards', 'd', card({ status: 'sold', binderId: null, page: null, slot: null }));
    const run = new TakeSoldCardsOutOfBinders(deps);
    assert.deepEqual(await run.execute(), { ok: true, value: { moved: 2 } });
    assert.deepEqual(ledger.tables.cards.get('a')?.['sale'], { from: { binderId: 'b1', page: 1, slot: 1 } });
    assert.equal(ledger.tables.cards.get('b')?.['binderId'], null);
    assert.equal(ledger.tables.cards.get('c')?.['slot'], 3);
    assert.equal(ledger.runs.length, 1);
    assert.deepEqual(published, [
      { type: 'DocumentSaved', collection: 'cards', id: 'a', occurredAt: NOW },
      { type: 'DocumentSaved', collection: 'cards', id: 'b', occurredAt: NOW },
    ]);
    assert.deepEqual(logged, ['Took 2 sold or traded cards out of their binders']);
    assert.deepEqual(await run.execute(), { ok: true, value: { moved: 0 } });
    assert.equal(logged.length, 1);
  });
});
