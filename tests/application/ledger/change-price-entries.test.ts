import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChangePriceEntries } from '#application/ledger/change-price-entries.ts';
import { card, setUp } from '../fixtures.ts';

const entry = (id: string, amount = 10) => ({ id, type: 'market', amount, currency: 'CAD' });

describe('ChangePriceEntries', () => {
  it('changes the entries against the card as it is now, with the fields that go with them', async () => {
    const { ledger, deps, published } = setUp();
    ledger.seed('cards', 'c1', card({ prices: [entry('a'), entry('daily', 12)] }));
    const r = await new ChangePriceEntries(deps).execute({ cardId: 'c1', update: [entry('a', 20)], add: [entry('sale', 30)], fields: { status: 'sold' } });
    assert.ok(r.ok);
    assert.deepEqual(r.value['prices'], [entry('a', 20), entry('daily', 12), entry('sale', 30)]);
    assert.equal(r.value['status'], 'sold');
    assert.deepEqual(ledger.tables.cards.get('c1')?.['prices'], r.value['prices']);
    assert.equal(published.length, 1);
  });

  it('refuses before looking at the card: a bad id, or the list sent as a field', async () => {
    const { deps, ledger } = setUp();
    const change = new ChangePriceEntries(deps);
    assert.deepEqual(await change.execute({ cardId: 'bad id' }), { ok: false, error: { code: 'INVALID_ID', id: 'bad id' } });
    assert.deepEqual(await change.execute({ cardId: 'missing', fields: { prices: [] } }), { ok: false, error: { code: 'PRICES_SENT_AS_FIELDS' } });
    assert.deepEqual(ledger.runs, []);
  });

  it('refuses a card that is gone, or an entry changed meanwhile, saving nothing', async () => {
    const { ledger, deps } = setUp();
    ledger.seed('cards', 'c1', card({ prices: [entry('a')] }));
    const change = new ChangePriceEntries(deps);
    assert.deepEqual(await change.execute({ cardId: 'missing', add: [entry('b')] }), { ok: false, error: { code: 'CARD_NOT_FOUND' } });
    assert.deepEqual(await change.execute({ cardId: 'c1', update: [entry('gone')], fields: { status: 'sold' } }), { ok: false, error: { code: 'PRICE_ENTRY_GONE' } });
    assert.deepEqual(ledger.tables.cards.get('c1'), card({ prices: [entry('a')] }));
  });

  it('refuses fields that put the card in a different card’s pocket, saving nothing', async () => {
    const { ledger, deps, published } = setUp();
    ledger.seed('cards', 'c1', card({ slot: 1 }));
    ledger.seed('cards', 'c2', card({ name: 'Pikachu', number: '58/102', slot: 2 }));
    ledger.seed('cards', 'c3', card({ slot: 3 }));
    const change = new ChangePriceEntries(deps);
    assert.deepEqual(await change.execute({ cardId: 'c1', add: [entry('a')], fields: { slot: 2 } }), { ok: false, error: { code: 'POCKET_HOLDS_ANOTHER_CARD', name: 'Pikachu' } });
    assert.deepEqual(ledger.tables.cards.get('c1'), card({ slot: 1 }));
    assert.deepEqual(published, []);
    // The same card's pocket is fine, and so is a change that keeps the place.
    assert.equal((await change.execute({ cardId: 'c1', add: [entry('b')], fields: { slot: 3 } })).ok, true);
    assert.equal((await change.execute({ cardId: 'c2', add: [entry('c')], fields: { status: 'sold' } })).ok, true);
  });
});
