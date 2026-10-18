import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPriceEntries, checkPriceEntryFields, type PriceEntry } from '#domain/cards/price-entries.ts';

const entry = (id: string, over: Record<string, unknown> = {}): PriceEntry => ({ id, at: '2026-10-01T12:00:00.000Z', type: 'market', amount: 10, currency: 'CAD', date: '2026-10-01', where: '', note: '', ...over });
const daily = entry('daily', { auto: true, amount: 12.5, date: '2026-10-02', where: 'PriceCharting', note: 'Daily update' });

describe('price entries changed by id', () => {
  it('applies them to the list the card has now, keeping what was added meanwhile', () => {
    const a = entry('a'), b = entry('b');
    // The page read [a, b]; the daily update has added its entry since.
    const now = [a, b, daily];
    assert.deepEqual(applyPriceEntries(now, { add: [entry('c')] }), { ok: true, value: [a, b, daily, entry('c')] });
    assert.deepEqual(applyPriceEntries(now, { remove: ['a'] }), { ok: true, value: [b, daily] });
    assert.deepEqual(applyPriceEntries(now, { update: [{ ...b, amount: 30 }] }), { ok: true, value: [a, { ...b, amount: 30 }, daily] });
    // An entry already there isn't added twice; one already gone is fine to remove.
    assert.deepEqual(applyPriceEntries(now, { add: [a], remove: ['gone'] }), { ok: true, value: now });
    // Changing an entry removed meanwhile would bring it back: refused.
    assert.deepEqual(applyPriceEntries(now, { update: [entry('gone')] }), { ok: false, error: { code: 'PRICE_ENTRY_GONE' } });
  });

  it('starts from an empty list when the card has none', () => {
    assert.deepEqual(applyPriceEntries(undefined, { add: [entry('a')] }), { ok: true, value: [entry('a')] });
  });

  it('never takes the list (or the id) as a plain field', () => {
    assert.deepEqual(checkPriceEntryFields({ status: 'sold' }), { ok: true, value: undefined });
    assert.deepEqual(checkPriceEntryFields(undefined), { ok: true, value: undefined });
    assert.deepEqual(checkPriceEntryFields({ prices: [] }), { ok: false, error: { code: 'PRICES_SENT_AS_FIELDS' } });
    assert.deepEqual(checkPriceEntryFields({ id: 'c2' }), { ok: false, error: { code: 'PRICES_SENT_AS_FIELDS' } });
  });
});
