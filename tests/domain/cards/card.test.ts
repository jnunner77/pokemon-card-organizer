import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Card, type CardId } from '#domain/cards/card.ts';
import { AT, card, cardFields, value } from '../fixtures.ts';

const id = 'c1' as CardId;

describe('Card', () => {
  it('is created from a valid document, and says so', () => {
    const c = value(Card.create(id, { id: 'ignored', ...cardFields() }, AT));
    assert.deepEqual(c.toSnapshot(), { id, fields: cardFields() });
    assert.deepEqual(c.pullEvents(), [{ type: 'DocumentSaved', collection: 'cards', id, occurredAt: AT }]);
    assert.deepEqual(c.pullEvents(), []);
  });

  it('refuses an invalid document', () => {
    assert.deepEqual(Card.create(id, cardFields({ page: 0 }), AT), { ok: false, error: { code: 'INVALID_DOCUMENT', message: 'page: Too small: at least 1' } });
  });

  it('is replaced whole, or merged field by field', () => {
    const c = card('c1');
    value(c.replace({ name: 'Mew' }, AT));
    assert.deepEqual(c.fields, { name: 'Mew' });
    value(c.merge({ status: 'sold', binderId: null }, AT));
    assert.deepEqual(c.fields, { name: 'Mew', status: 'sold', binderId: null });
    assert.equal(c.pullEvents().length, 2);
  });

  it('stays as it was when a change is refused', () => {
    const c = card('c1');
    assert.equal(c.merge({ slot: 0 }, AT).ok, false);
    assert.deepEqual(c.fields, cardFields());
    assert.deepEqual(c.pullEvents(), []);
  });

  it('knows where it is', () => {
    assert.deepEqual(card('c1').place, { binderId: 'b1', page: 1, slot: 2 });
    assert.deepEqual(card('c2', { binderId: null, page: null, slot: null }).place, { binderId: null, page: null, slot: null });
  });

  it('moves, stamping when; staying put is not a move', () => {
    const c = card('c1');
    assert.deepEqual(c.moveTo({ binderId: 'b1', page: 1, slot: 2 }, AT), { ok: true, value: false });
    assert.deepEqual(c.moveTo({ binderId: 'b2', page: 3, slot: 4 }, AT), { ok: true, value: true });
    assert.deepEqual(c.place, { binderId: 'b2', page: 3, slot: 4 });
    assert.equal(c.fields['updatedAt'], AT.toISOString());
    assert.deepEqual(c.moveWithinBinder(3, 4, AT), { ok: true, value: false });
    assert.deepEqual(c.moveWithinBinder(1, 1, AT), { ok: true, value: true });
    assert.deepEqual(c.place, { binderId: 'b2', page: 1, slot: 1 });
  });

  it('changes its price entries with the fields that go with them', () => {
    const c = card('c1');
    value(c.changePriceEntries({ add: [{ id: 'sale', type: 'sold', amount: 30, currency: 'CAD' }], fields: { status: 'sold' } }, AT));
    assert.equal(c.fields['status'], 'sold');
    const prices = c.fields['prices'];
    assert.ok(Array.isArray(prices));
    assert.equal(prices.length, 2);
    assert.deepEqual(c.changePriceEntries({ fields: { prices: [] } }, AT), { ok: false, error: { code: 'PRICES_SENT_AS_FIELDS' } });
    assert.deepEqual(c.changePriceEntries({ update: [{ id: 'gone' }] }, AT), { ok: false, error: { code: 'PRICE_ENTRY_GONE' } });
    assert.equal(c.changePriceEntries({ add: [{ id: 'bad', type: 'market', amount: -5, currency: 'CAD' }] }, AT).ok, false);
  });

  it('records its deletion', () => {
    const c = card('c1');
    c.delete(AT);
    assert.deepEqual(c.pullEvents(), [{ type: 'DocumentDeleted', collection: 'cards', id: 'c1', occurredAt: AT }]);
  });
});
