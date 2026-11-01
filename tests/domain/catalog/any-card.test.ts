import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { cardImage, numberWithTotal, printingsOf, searchHits, searchPlan, variantText } from '#domain/catalog/any-card.ts';
import { chooseVariant } from '#domain/catalog/printings.ts';
import type { TcgdexCard } from '#domain/catalog/tcgdex.ts';

const CHARIZARD = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../fixtures/tcgdex-charizard.json'), 'utf8')) as TcgdexCard;

describe('planning a search for any card', () => {
  it('tries the longest runs of words first, then each word, leaving printing and filler words out', () => {
    const plan = searchPlan('pokemon charizard base set holo 4/102');
    assert.ok(plan);
    assert.deepEqual(plan.numbers, ['4/102']);
    assert.deepEqual(
      plan.tries.map((t) => [t.value, t.rest.join(' ')]),
      [
        ['charizard base set', ''],
        ['charizard base', 'set'],
        ['base set', 'charizard'],
        ['charizard', 'base set'],
        ['base', 'charizard set'],
        ['set', 'charizard base'],
      ],
    );
  });

  it('searches by number when only numbers are typed, and nothing for printing words alone', () => {
    assert.deepEqual(searchPlan('004/102')?.tries, [{ by: 'number', value: '4', name: '', rest: [] }]);
    assert.deepEqual(searchPlan('SWSH050')?.tries, [{ by: 'number', value: 'SWSH050', name: '', rest: [] }]);
    assert.equal(searchPlan('1st edition holo'), null);
    assert.equal(searchPlan('   '), null);
    // "pokemon" alone is still a name.
    assert.deepEqual(searchPlan('pokemon')?.tries.map((t) => t.value), ['Pokémon']);
  });

  it('asks at most six runs of several words, then each word of three letters or more', () => {
    const plan = searchPlan('zzz qq ww ee rr tt');
    assert.equal(plan?.tries.length, 7);
  });
});

describe('ranking the cards a search found', () => {
  const sets = [
    { id: 'base1', name: 'Base Set', cardCount: { official: 102 } },
    { id: 'base4', name: 'Base Set 2', cardCount: { official: 130 } },
    { id: 'A1', name: 'Genetic Apex' },
    { id: 'sv03.5', name: '151', cardCount: { official: 165 } },
  ];
  const found = [
    { id: 'base1-4', localId: '4', name: 'Charizard', image: 'https://img/base1/4' },
    { id: 'base4-4', localId: '4', name: 'Charizard' },
    { id: 'A1-36', localId: '36', name: 'Charizard' },
    { id: 'sv03.5-006', localId: '006', name: 'Charizard ex' },
    { id: 'sv03.5-151', localId: '151', name: 'Charizard' },
  ];
  const run = (query: string) => {
    const plan = searchPlan(query);
    assert.ok(plan);
    // The cards found by the search for "charizard".
    const byName = plan.tries.find((t) => t.name.toLowerCase() === 'charizard');
    assert.ok(byName);
    return searchHits(found, byName, plan.numbers, sets, new Set(['A1']))?.hits.map((h) => h.id) ?? null;
  };

  it('puts the exact name first, then newer sets, and leaves out TCG Pocket', () => {
    assert.deepEqual(run('charizard'), ['sv03.5-151', 'base4-4', 'base1-4', 'sv03.5-006']);
  });

  it("puts the card's number before a set name that has it, and the set named exactly first", () => {
    assert.deepEqual(run('charizard 151'), ['sv03.5-151', 'sv03.5-006']);
    assert.deepEqual(run('charizard 4/102'), ['base1-4']);
  });

  it('finds nothing when no card fits, so the next search is tried', () => {
    assert.equal(run('charizard jungle'), null);
  });

  it('describes each card found', () => {
    const plan = searchPlan('charizard 4/102');
    assert.ok(plan?.tries[0]);
    assert.deepEqual(searchHits(found, plan.tries[0], plan.numbers, sets, new Set()), { hits: [{ id: 'base1-4', name: 'Charizard', number: '4', total: 102, set: 'Base Set', thumb: 'https://img/base1/4/low.webp' }], more: false });
  });
});

describe("a card's printings", () => {
  it('names each printing as the Variant field would, so it prices the same printing', () => {
    for (const v of CHARIZARD.variants_detailed ?? []) assert.equal(chooseVariant(CHARIZARD, variantText(v)).variant, v);
    assert.deepEqual((CHARIZARD.variants_detailed ?? []).map(variantText), ['Holo', '1st Edition Shadowless Holo', 'Shadowless Holo', '1999 2000 Copyright Holo']);
    assert.equal(variantText({ type: 'reverse', foil: 'masterball' }), 'Master Ball');
    assert.equal(variantText({ type: 'reverse' }), 'Reverse Holo');
    assert.equal(variantText({ type: 'normal' }), '');
  });

  it("lists each variant with its own prices, or a card's printings when it lists no variants", () => {
    const [holo] = printingsOf(CHARIZARD);
    assert.deepEqual(holo, { label: 'holo', variant: 'Holo', tcgplayer: { usd: 928.32, productId: '42382' }, product: '42382' });
    const plain: TcgdexCard = { id: 'x-1', localId: '1', name: 'X', set: { id: 'x', name: 'X' }, pricing: { tcgplayer: { normal: { productId: 7, marketPrice: 1.5 }, reverseHolofoil: { productId: 7, marketPrice: 3 } }, cardmarket: { 'trend-holo': 2 } } };
    assert.deepEqual(printingsOf(plain).map((p) => [p.label, p.tcgplayer?.usd ?? null]), [
      ['regular', 1.5],
      ['reverse', 3],
    ]);
  });

  it("doesn't list a printing only Cardmarket prices", () => {
    const td: TcgdexCard = { id: 'x-2', localId: '2', name: 'Y', set: { id: 'x', name: 'X' }, pricing: { tcgplayer: { normal: { productId: 7, marketPrice: 1.5 } }, cardmarket: { 'trend-holo': 2 } } };
    assert.deepEqual(printingsOf(td).map((p) => p.label), ['regular']);
  });

  it('pictures it by TCGdex, else its TCGplayer product, and numbers it with its set size', () => {
    assert.equal(cardImage(CHARIZARD, '1'), 'https://assets.tcgdex.net/en/base/base1/4/high.webp');
    assert.equal(cardImage({ ...CHARIZARD, image: undefined }, '42382'), 'https://tcgplayer-cdn.tcgplayer.com/product/42382_in_1000x1000.jpg');
    assert.equal(cardImage({ ...CHARIZARD, image: undefined }, null), null);
    assert.deepEqual([numberWithTotal('4', 102), numberWithTotal('SWSH050', 307), numberWithTotal('4', null)], ['4/102', 'SWSH050', '4']);
  });
});
