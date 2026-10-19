import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardsNeedingAttention, checkIdentity, DETAILS_VERSION, detailsProblem, NO_PRICE } from '#domain/cards/attention.ts';

const card = { name: 'Lapras', set: '30th Celebration', number: '131/128', status: 'binder' };

describe('cards that need a person', () => {
  it('list cards without a certain match, matched to a product without a price, or whose sources disagree', () => {
    assert.deepEqual(
      cardsNeedingAttention([
        { ...card, name: 'Bill', set: 'Base Set', number: '118/130', pricing: { source: 'none', candidates: [] } },
        { ...card, name: 'Pikachu', setCode: 'M22', number: '7/15', pricing: { source: 'tcgplayer', id: '1', error: `TCGplayer ${NO_PRICE} of the card.` } },
        { ...card, name: 'Gengar', pricing: { source: 'pricecharting', id: '2', error: "PriceCharting didn't answer." } },
        { ...card, name: 'Eevee', pricing: { source: 'none', error: "Couldn't reach PriceCharting" } },
        { ...card, name: 'Sold one', status: 'sold', pricing: { source: 'none', candidates: [] } },
        { ...card, name: 'Mew', pricing: { source: 'tcgplayer', id: '3', disagree: { quotes: { pricecharting: 10, tcgplayer: 40 }, sig: 's1' } } },
        { ...card, name: 'Mewtwo', pricesDisagreeIgnored: 's2', pricing: { source: 'tcgplayer', id: '4', disagree: { quotes: { pricecharting: 10 }, sig: 's2' } } },
      ]),
      [
        'Bill Base Set 118/130: no certain match. Open the card and choose the product.',
        'Pikachu M22 7/15: TCGplayer has no price for this printing of the card.',
        'Mew 30th Celebration 131/128: its price sources disagree (pricecharting US$10.00, tcgplayer US$40.00); one of its matches may be the wrong card. Open Cards to check in the binder.',
      ],
    );
  });

  it('list cards whose details look wrong, unless ignored for this name and number', () => {
    const details = (d: Record<string, unknown>) => ({ v: DETAILS_VERSION, checkedAt: '2026-10-01T00:00:00Z', ...d });
    assert.equal(detailsProblem({ ...card, details: details({ result: 'several' }) }), 'several cards match. Choose yours.');
    assert.equal(detailsProblem({ ...card, details: details({ result: 'notFound', suggest: [{ name: 'Lapras ex' }] }) }), 'not in the card database. Did you mean Lapras ex?');
    assert.equal(detailsProblem({ ...card, details: details({ result: 'notFound' }) }), 'not in the card database (TCGdex). Check its name and number, or ignore it.');
    // A price site that matched it confirms it.
    assert.equal(detailsProblem({ ...card, pricing: { source: 'pricecharting', id: '/game/x' }, details: details({ result: 'notFound' }) }), null);
    assert.equal(detailsProblem({ ...card, details: details({ filedUnder: { as: '30th Celebration', name: 'Aquapolis' }, set: '30th Celebration' }) }), "filed under Aquapolis, but it's from 30th Celebration.");
    assert.equal(detailsProblem({ ...card, checksIgnored: checkIdentity(card), details: details({ result: 'several' }) }), null);
    assert.equal(detailsProblem({ ...card, details: { v: DETAILS_VERSION - 1, result: 'several' } }), null);
    assert.equal(checkIdentity({ name: ' Lapras ', number: '131 / 128' }), 'lapras|131/128');
  });

  it('name at most ten and count the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `Card ${i + 1}`, pricing: { source: 'none', candidates: [] } }));
    const out = cardsNeedingAttention(many);
    assert.equal(out.length, 11);
    assert.equal(out[10], '…and 3 more. Open Cards to check in the binder.');
  });
});
