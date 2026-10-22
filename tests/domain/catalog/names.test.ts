import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asPrinted, cardNumber, isoDate, ownNumber, searchWord, setLabel, setSize, similarity, withoutBrackets } from '#domain/catalog/names.ts';
import { mapRarity } from '#domain/catalog/rarity.ts';
import { isPocketSet, isSubSet, setOfCard } from '#domain/catalog/tcgdex.ts';
import { ownNumber as productNumber, productName, setName } from '#domain/catalog/tcgplayer.ts';

describe('names and numbers however they are written', () => {
  it("puts rarities in the ledger's words", () => {
    assert.deepEqual(
      ['Double rare', 'Rare Holo', 'Holo Rare VSTAR', 'Illustration rare', 'Special illustration rare', 'ACE SPEC Rare', 'None', '', 'Amazing Rare', 'rare secret'].map(mapRarity),
      ['Double Rare', 'Holo Rare', 'Ultra Rare', 'Illustration Rare', 'Special Illustration Rare', 'ACE SPEC Rare', null, null, 'Amazing Rare', 'Secret Rare'],
    );
  });

  it('tells a misspelling from a different name', () => {
    assert.ok(similarity('Mega Eelktross EX', 'Mega Eelektross ex') > 0.9);
    assert.ok(similarity('Nidorina', 'Pikachu') < 0.5);
    assert.equal(similarity('', 'Pikachu'), 0);
  });

  it("reads the card's own number and the set size typed with it", () => {
    assert.deepEqual(['051', '51/162', ' SWSH298 ', 'TG10/TG30'].map(ownNumber), ['51', '51', 'swsh298', 'tg10']);
    assert.deepEqual(['131/128', '024', 'SWSH050'].map(cardNumber), ['131', '24', 'swsh50']);
    assert.deepEqual(['TG10/TG30', '074/131', '4', 'SWSH050'].map(productNumber), ['tg10', '74', '4', 'swsh50']);
    assert.deepEqual([setSize('51/162'), setSize('51'), setSize('51 / 99 ')], [162, null, 99]);
  });

  it('searches by the word TCGdex needs, as printed', () => {
    assert.equal(searchWord("N's Zekrom"), 'Zekrom');
    assert.equal(searchWord('Hole-Digging Shovel'), 'Digging');
    assert.equal(searchWord('Pokemon Center Lady'), 'Center');
    assert.equal(searchWord('Pokedex'), 'Pokédex');
    assert.equal(searchWord('Charizard V'), 'Charizard');
    assert.equal(withoutBrackets("Sleep! (Rocket's Secret Machine)"), 'Sleep!');
    assert.equal(asPrinted('flabebe'), 'Flabébé');
  });

  it('reads set labels and dates', () => {
    assert.equal(setLabel('Pokemon Crown Zenith'), 'Crown Zenith');
    assert.equal(setLabel('Pokémon Base Set'), 'Base Set');
    assert.deepEqual([isoDate('2026-03-27'), isoDate('1999/01/09'), isoDate('March 2026')], ['2026-03-27', '1999-01-09', null]);
  });

  it("knows a set's reprint sub-sets and TCG Pocket's sets", () => {
    assert.deepEqual([isSubSet('30th', '30th-c'), isSubSet('swsh9', 'swsh9tg'), isSubSet('cel25', 'cel25c'), isSubSet('base1', 'base4'), isSubSet('sv03', 'sv03.5')], [true, true, true, false, false]);
    assert.equal(setOfCard({ id: '30th-c-029', localId: '029', name: 'Lugia' }), '30th-c');
    assert.equal(setOfCard({ id: 'A4-149', localId: '149', name: 'Lugia' }), 'A4');
    assert.deepEqual([isPocketSet('A1', new Set()), isPocketSet('P-A', new Set()), isPocketSet('B2', new Set()), isPocketSet('sm9', new Set()), isPocketSet('odd', new Set(['odd']))], [true, true, true, false, true]);
  });

  it("reads TCGplayer's product names and sets", () => {
    assert.deepEqual(productName('Eevee (Poke Ball Pattern) - 133/165'), { base: 'Eevee', variant: 'Poke Ball Pattern' });
    assert.deepEqual(productName('Missingno - 26/25'), { base: 'Missingno', variant: '' });
    assert.equal(setName({ name: 'SWSH11: Lost Origin Trainer Gallery' }), 'Lost Origin Trainer Gallery');
    assert.equal(setName({ name: 'Base Set' }), 'Base Set');
  });
});
