import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DETAILS_VERSION } from '#domain/cards/attention.ts';
import { entriesOf, familyOf, groupOf, groupPairs, isExtra, masterSet, placeholderCards, setChoices, setNamed, subGroupsOf, tcgplayerPrintings, tcgVariant, variantsOf } from '#domain/catalog/master-sets.ts';
import type { TcgdexCard, TcgdexVariant } from '#domain/catalog/tcgdex.ts';
import type { TcgGroup } from '#domain/catalog/tcgplayer.ts';

const v = (type: string, foil?: string, stamp?: string[], subtype?: string): TcgdexVariant => ({ type, foil, stamp, subtype });

describe('promo printings', () => {
  it('are stamped, metal, or a foil on a card that also comes plain', () => {
    const regular = v('normal'), reverse = v('reverse'), ball = v('reverse', 'pokeball'), master = v('reverse', 'masterball');
    const stamped = v('normal', undefined, ['gamestop']), cosmos = v('holo', 'cosmos'), metal = v('metal', 'gold');
    const all = [regular, reverse, ball, master, stamped, cosmos, metal];
    assert.deepEqual(all.map((x) => isExtra(x, all)), [false, false, false, false, true, true, true]);
    // 1st Edition is part of the set; a holo that is only ever galaxy foil (Fossil) is the card itself.
    const galaxy = v('normal', 'galaxy'), first = v('normal', 'galaxy', ['1st-edition']), print4 = v('normal', undefined, undefined, '1999-2000-copyright');
    assert.deepEqual([galaxy, first, print4].map((x) => isExtra(x, [galaxy, first, print4])), [false, false, false]);
    // The EX era's reverse holos carry the set's logo: the set's own, unless there's a plain one too.
    const logo = v('reverse', undefined, ['set-logo']);
    assert.equal(isExtra(logo, [regular, logo]), false);
    assert.equal(isExtra(logo, [regular, reverse, logo]), true);
  });

  it("come from a card's simple flags when it has no detailed list, jumbo cards left out", () => {
    const card = (over: Partial<TcgdexCard>): TcgdexCard => ({ id: 'x-1', localId: '1', name: 'X', set: { id: 'x', name: 'X' }, ...over });
    assert.deepEqual(variantsOf(card({ variants: { normal: true, reverse: true, firstEdition: true } })), [{ type: 'normal' }, { type: 'reverse' }, { type: 'normal', stamp: ['1st-edition'] }]);
    assert.deepEqual(variantsOf(card({ variants_detailed: [{ type: 'holo', size: 'jumbo' }, { type: 'holo', size: 'standard' }] })), [{ type: 'holo', size: 'standard' }]);
    assert.deepEqual(variantsOf(card({})), [{ type: 'normal' }]);
  });
});

describe("TCGplayer's catalog", () => {
  it('names its printings as Variants', () => {
    assert.deepEqual(
      [['', 'Normal'], ['', 'Holofoil'], ['', 'Reverse Holofoil'], ['', '1st Edition Holofoil'], ['Poke Ball Pattern', 'Holofoil'], ['Poke Ball Pattern', 'Reverse Holofoil'], ['Reverse Holofoil', 'Reverse Holofoil']].map(([b, t]) => tcgVariant(b ?? '', t ?? '')),
      ['', 'Holo', 'Reverse Holo', '1st Edition Holo', 'Poke Ball Pattern', 'Poke Ball Pattern Reverse Holo', 'Reverse Holo'],
    );
  });

  it("finds the set by TCGdex's name for it, however TCGplayer writes it", () => {
    const groups: TcgGroup[] = [
      ...['SV: Scarlet & Violet 151', 'SWSH11: Lost Origin', 'SWSH11: Lost Origin Trainer Gallery', 'Hidden Fates', 'Hidden Fates: Shiny Vault', 'Base Set', 'Base Set 2', 'Base Set (Shadowless)'],
      ...['Black and White', 'XY - Evolutions', 'SV01: Scarlet & Violet Base Set', 'EX Ruby and Sapphire', "McDonald's Promos 2019", 'SM Base Set', 'Generations', 'Generations: Radiant Collection'],
    ].map((name, i) => ({ groupId: i, name }));
    const of = (n: string, id = 'x') => groupOf(groups, id, n)?.name ?? null;
    assert.deepEqual(
      [of('151'), of('Lost Origin'), of('Lost Origin Trainer Gallery'), of('Hidden Fates Shiny Vault'), of('Base Set'), of('Jungle')],
      ['SV: Scarlet & Violet 151', 'SWSH11: Lost Origin', 'SWSH11: Lost Origin Trainer Gallery', 'Hidden Fates: Shiny Vault', 'Base Set', null],
    );
    assert.deepEqual(
      [of('Black & White'), of('Evolutions'), of('Scarlet & Violet'), of('Ruby & Sapphire'), of("McDonald's Collection 2019"), of('Sun & Moon', 'sm1')],
      ['Black and White', 'XY - Evolutions', 'SV01: Scarlet & Violet Base Set', 'EX Ruby and Sapphire', "McDonald's Promos 2019", 'SM Base Set'],
    );
    assert.deepEqual(subGroupsOf(groups, 'Generations').map((g) => g.name), ['Generations: Radiant Collection']);
    assert.deepEqual(subGroupsOf(groups, 'Hidden Fates').map((g) => g.name), ['Hidden Fates: Shiny Vault']);
  });
});

describe('a master set from its cards', () => {
  const sets = setChoices(
    [
      { id: 'sm115', name: 'Hidden Fates', cardCount: { total: 69 } },
      { id: 'sma', name: 'Hidden Fates Shiny Vault', cardCount: { total: 94 } },
      { id: 'A1', name: 'Genetic Apex' },
      { id: 'jumbo', name: 'Jumbo cards' },
    ],
    new Set(),
  );
  const set = setNamed(sets, 'hidden fates');
  const card = (id: string, localId: string, name: string, setId: string, variants_detailed: TcgdexVariant[]): TcgdexCard => ({ id, localId, name, set: { id: setId, name: setId === 'sma' ? 'Hidden Fates Shiny Vault' : 'Hidden Fates', cardCount: { official: 68 } }, rarity: 'Rare Holo', variants_detailed });

  it('is chosen by name or id, with its sub-sets, never TCG Pocket or jumbo cards', () => {
    assert.deepEqual(sets.map((s) => s.id), ['sm115', 'sma']);
    assert.ok(set);
    assert.deepEqual(familyOf(set, sets).map((s) => s.id), ['sm115', 'sma']);
    assert.equal(setNamed(sets, 'SMA')?.name, 'Hidden Fates Shiny Vault');
    assert.equal(setNamed(sets, ''), null);
  });

  it("lists each card's variants, adds the ones TCGplayer lists, and sorts them by set and number", () => {
    assert.ok(set);
    const family = familyOf(set, sets);
    const full = [card('sma-SV49', 'SV49', 'Charizard GX', 'sma', [{ type: 'holo' }]), card('sm115-9', '9', 'Charizard', 'sm115', [{ type: 'holo' }]), card('sm115-10', '10', 'Ninetales', 'sm115', [{ type: 'normal' }])];
    const infos = new Map([['sm115', { id: 'sm115', name: 'Hidden Fates', abbreviation: { official: 'HIF' }, releaseDate: '2019/08/23' }]]);
    const entries = entriesOf(full, infos);
    assert.deepEqual(entries.map((e) => [e.number, e.variant, e.setCode, e.released]), [
      ['SV49', '', null, null],
      ['9/68', '', 'HIF', '2019-08-23'],
      ['10/68', '', 'HIF', '2019-08-23'],
    ]);
    // TCGplayer lists Ninetales' reverse holo too.
    const groups: TcgGroup[] = [{ groupId: 1, name: 'Hidden Fates' }];
    const pairs = groupPairs(groups, family, set);
    const [pair] = pairs;
    assert.ok(pair);
    const products = [{ productId: 5, groupId: 1, name: 'Ninetales', extendedData: [{ name: 'Number', value: '10/68' }] }];
    const prices = [{ productId: 5, subTypeName: 'Normal' }, { productId: 5, subTypeName: 'Reverse Holofoil' }];
    const added = tcgplayerPrintings({ family, set, pairs, infos, full, entries, added: 0 }, pair, { products, prices });
    assert.deepEqual(added.map((e) => [e.tcgdexId, e.tcgplayerId, e.variant, e.order]), [['sm115-10', '5', 'Reverse Holo', 100]]);
    const m = masterSet(set, family, [...entries, ...added], { checked: true, added: 1, sets: ['Hidden Fates'] });
    assert.deepEqual(m.entries.map((e) => `${e.number} ${e.variant}`.trim()), ['9/68', '10/68', '10/68 Reverse Holo', 'SV49']);
    assert.equal(m.cards, 3);
  });

  it('becomes placeholder cards filling the pages in order, matched to their cards', () => {
    const entry = { tcgdexId: 'sm115-9', tcgplayerId: null, name: 'Charizard', set: 'Hidden Fates', setId: 'sm115', setCode: 'HIF', number: '9/68', rarity: 'Holo Rare', variant: '', artist: null, released: '2019-08-23', thumb: null, extra: false };
    const only = { ...entry, tcgdexId: null, tcgplayerId: '5', variant: 'Reverse Holo' };
    const cards = placeholderCards([entry, entry, only], { binderId: 'b1', pockets: 2, owner: 'Megan', now: '2026-10-11T12:00:00.000Z' });
    assert.deepEqual(cards.map((c) => [c['page'], c['slot']]), [[1, 1], [1, 2], [2, 1]]);
    assert.deepEqual(cards[0]?.['details'], { source: 'tcgdex', result: 'complete', v: DETAILS_VERSION, id: 'sm115-9', filled: [], setId: 'sm115', set: 'Hidden Fates', setCode: 'HIF', released: '2019-08-23', chosen: true, checkedAt: '2026-10-11T12:00:00.000Z' });
    assert.equal(cards[0]?.['pricing'], undefined);
    assert.deepEqual(cards[2]?.['pricing'], { source: 'tcgplayer', id: '5', url: 'https://www.tcgplayer.com/product/5', title: 'Charizard [Reverse Holo]', set: 'Hidden Fates', linkedBy: 'auto', linkedAt: '2026-10-11T12:00:00.000Z' });
    assert.equal(cards[2]?.['details'], null);
    assert.deepEqual([cards[0]?.['owner'], cards[0]?.['placeholder'], cards[0]?.['language'], cards[0]?.['rarity'], cards[0]?.['artist']], ['Megan', true, 'English', 'Holo Rare', '']);
  });
});
