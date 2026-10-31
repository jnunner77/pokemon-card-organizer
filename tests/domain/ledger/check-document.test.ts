import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDocument } from '#domain/ledger/check-document.ts';
import { MAX_DOC_BYTES } from '#domain/ledger/document.ts';
import { cardFields, value } from '../fixtures.ts';

const problem = (r: ReturnType<typeof checkDocument>) => {
  assert.ok(!r.ok, 'expected the document to be refused');
  return r.error.message;
};

describe('checking a card', () => {
  it('keeps its fields, drops its id, and keeps fields it does not know about', () => {
    const fields = value(checkDocument('cards', { id: 'c1', ...cardFields({ futureField: { a: 1 } }) }));
    assert.deepEqual(fields, cardFields({ futureField: { a: 1 } }));
    assert.equal('id' in fields, false);
  });

  it('accepts blanks: null or missing optional fields', () => {
    value(checkDocument('cards', {}));
    value(checkDocument('cards', { name: null, page: null, slot: null, sale: null, pricing: null, owner: null }));
  });

  it('refuses what is not a document, or too large a one', () => {
    assert.equal(problem(checkDocument('cards', [1, 2])), 'A document must be a JSON object');
    assert.equal(problem(checkDocument('cards', null)), 'A document must be a JSON object');
    assert.equal(problem(checkDocument('cards', { notes: 'x'.repeat(MAX_DOC_BYTES) })), 'That document is too large');
  });

  it('says which field is wrong and why', () => {
    assert.equal(problem(checkDocument('cards', cardFields({ page: 0 }))), 'page: Too small: at least 1');
    assert.equal(problem(checkDocument('cards', cardFields({ slot: 65 }))), 'slot: Too big: at most 64');
    assert.equal(problem(checkDocument('cards', cardFields({ page: 1.5 }))), 'page: Expected a whole number');
    assert.equal(problem(checkDocument('cards', cardFields({ name: 'x'.repeat(201) }))), 'name: Too long: at most 200 characters');
    assert.equal(problem(checkDocument('cards', cardFields({ placeholder: 'yes' }))), 'placeholder: Expected true or false');
    assert.equal(problem(checkDocument('cards', cardFields({ owner: 'Ash' }))), 'owner: Expected one of "", "Megan", "Justin", "Maiya", "Both"');
    assert.equal(problem(checkDocument('cards', cardFields({ imagePref: 'drawing' }))), 'imagePref: Expected one of "official", "photo"');
  });

  it('checks the price for guests', () => {
    value(checkDocument('cards', cardFields({ guestPrice: 3 })));
    value(checkDocument('cards', cardFields({ guestPrice: null })));
    value(checkDocument('cards', cardFields({ guestPrice: 2.5 })));
    for (const bad of [0, -1, '3', 100_000_001, 2.555, 0.001]) assert.match(problem(checkDocument('cards', cardFields({ guestPrice: bad }))), /^guestPrice: /);
  });

  it('checks price entries', () => {
    assert.equal(problem(checkDocument('cards', cardFields({ prices: [{ type: 'market', amount: -1, currency: 'CAD' }] }))), 'prices.0.amount: Too small: at least 0');
    assert.equal(problem(checkDocument('cards', cardFields({ prices: [{ amount: 1, currency: 'CAD' }] }))), 'prices.0.type: Required');
    assert.equal(problem(checkDocument('cards', cardFields({ prices: 'none' }))), 'prices: Expected a list');
    assert.equal(problem(checkDocument('cards', cardFields({ prices: [{ type: 'market', amount: 1, currency: 'CAD', quotes: { amazon: 3 } }] }))), 'prices.0.quotes.amazon: Expected one of "pricecharting", "tcgplayer", "cardmarket", "ebay"');
    value(checkDocument('cards', cardFields({ prices: [{ type: 'market', amount: 1, currency: 'CAD', auto: true, usd: 0.7, quotes: { pricecharting: 0.7, tcgplayer: 0.6 }, extra: 'kept' }] })));
  });

  it('checks a bundle sale', () => {
    const bundle = { id: 'b1', total: 18, currency: 'CAD', count: 3, split: 'value' };
    value(checkDocument('cards', cardFields({ sale: { amount: 6, soldCAD: 6, bundle } })));
    assert.equal(problem(checkDocument('cards', cardFields({ sale: { bundle: { ...bundle, count: 0 } } }))), 'sale.bundle.count: Too small: at least 1');
    assert.equal(problem(checkDocument('cards', cardFields({ sale: { bundle: { ...bundle, total: -1 } } }))), 'sale.bundle.total: Too small: at least 0');
  });

  it('checks the price link and its pair', () => {
    value(checkDocument('cards', cardFields({ pricing: { source: 'none', candidates: [{ source: 'tcgplayer', id: '1', title: 'x' }], pair: { source: 'tcgplayer', off: true } } })));
    assert.equal(problem(checkDocument('cards', cardFields({ pricing: { source: 'ebay' } }))), 'pricing.source: Expected one of "pricecharting", "tcgplayer", "none", "off"');
    assert.equal(problem(checkDocument('cards', cardFields({ pricing: { source: 'none', candidates: Array(17).fill({ source: 'x', id: 'y' }) } }))), 'pricing.candidates: Too many: at most 16');
    assert.equal(problem(checkDocument('cards', cardFields({ pricing: { source: 'none', pair: { source: 'none' } } }))), 'pricing.pair.source: Expected one of "pricecharting", "tcgplayer"');
  });
});

describe('checking a binder', () => {
  it('needs a name', () => {
    assert.equal(problem(checkDocument('binders', { color: 'red' })), 'name: Required');
    value(checkDocument('binders', { name: 'IR', color: '#F2B705', pockets: 9, order: 1, kind: 'case', owner: 'Megan' }));
  });

  it('checks its pockets and kind', () => {
    assert.equal(problem(checkDocument('binders', { name: 'IR', pockets: 65 })), 'pockets: Too big: at most 64');
    assert.equal(problem(checkDocument('binders', { name: 'IR', kind: 'box' })), 'kind: Expected one of "binder", "case"');
  });

  it('keeps only the id, page and pocket of each place in its saved layout', () => {
    const fields = value(checkDocument('binders', { name: 'IR', layout: { savedAt: '2026-10-18T12:00:00.000Z', places: [{ id: 'c1', page: 1, slot: 2, extra: true }] } }));
    assert.deepEqual(fields['layout'], { savedAt: '2026-10-18T12:00:00.000Z', places: [{ id: 'c1', page: 1, slot: 2 }] });
    assert.equal(problem(checkDocument('binders', { name: 'IR', layout: { savedAt: 'x', places: [{ id: 'bad id', page: 1, slot: 1 }] } })), 'layout.places.0.id: Ids are letters, digits, - and _ (at most 64)');
  });
});

describe('checking a setting', () => {
  it('needs a sensible exchange rate', () => {
    value(checkDocument('settings', { usdToCad: 1.41 }));
    assert.equal(problem(checkDocument('settings', { usdToCad: 0 })), 'usdToCad: Too small: more than 0');
    assert.equal(problem(checkDocument('settings', { usdToCad: 101 })), 'usdToCad: Too big: at most 100');
  });
});
