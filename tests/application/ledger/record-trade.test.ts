import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RecordTrade } from '#application/ledger/record-trade.ts';
import { UndoTrade } from '#application/ledger/undo-trade.ts';
import { card, setUp } from '../fixtures.ts';

const sale = { amount: 25, currency: 'CAD', soldCAD: 25, date: '2026-10-25', where: 'Trade' };
const entry = { id: 'sale1', type: 'mysale', amount: 25, currency: 'CAD', date: '2026-10-25', where: 'Trade' };

describe('RecordTrade and UndoTrade', () => {
  it('records the trade as one unit of work, logs it, and undoes it', async () => {
    const { ledger, deps, logged, published } = setUp();
    ledger.seed('binders', 'b1', { name: 'One', pockets: 9 });
    ledger.seed('cards', 'x', card());
    const r = await new RecordTrade(deps).execute({
      actor: 'justin',
      tradeId: 't1',
      given: [{ cardId: 'x', sale, entry }],
      received: [{ kind: 'new', cardId: 'n1', binderId: 'b1', doc: { name: 'Mew' }, entries: [] }],
    });
    assert.ok(r.ok);
    assert.deepEqual(r.value.cards.map((c) => c.id), ['n1', 'x']);
    assert.deepEqual([ledger.tables.cards.get('x')?.['status'], ledger.tables.cards.get('n1')?.['slot']], ['traded', 2]);
    assert.equal(published.length, 2);

    const u = await new UndoTrade(deps).execute({ actor: 'justin', tradeId: 't1' });
    assert.ok(u.ok);
    assert.deepEqual(u.value.deleted, ['n1']);
    assert.equal(ledger.tables.cards.has('n1'), false);
    assert.deepEqual([ledger.tables.cards.get('x')?.['status'], ledger.tables.cards.get('x')?.['slot']], ['binder', 1]);
    assert.deepEqual(logged, ['justin recorded a trade: 1 card traded away, 1 card in', 'justin undid a trade']);
  });

  it('saves, publishes and logs nothing when the trade is refused', async () => {
    const { ledger, deps, logged, published } = setUp();
    ledger.seed('cards', 'x', card());
    const r = await new RecordTrade(deps).execute({ actor: 'justin', tradeId: 't1', given: [{ cardId: 'x', sale, entry }], received: [{ kind: 'new', cardId: 'n1', binderId: 'gone', doc: {}, entries: [] }] });
    assert.deepEqual(r, { ok: false, error: { code: 'BINDER_GONE' } });
    assert.equal(ledger.tables.cards.get('x')?.['status'], 'binder');
    assert.deepEqual([logged, published], [[], []]);
  });
});
