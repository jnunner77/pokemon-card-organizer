import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CreateMasterSet } from '#application/catalog/create-master-set.ts';
import { ListMasterSetSets } from '#application/catalog/list-master-set-sets.ts';
import { PreviewMasterSet } from '#application/catalog/preview-master-set.ts';
import { DETAILS_VERSION } from '#domain/cards/attention.ts';
import { variantText } from '#domain/catalog/master-sets.ts';
import { chooseVariant } from '#domain/catalog/printings.ts';
import type { TcgdexCard } from '#domain/catalog/tcgdex.ts';
import type { TcgGroup, TcgGroupContents } from '#domain/catalog/tcgplayer.ts';
import { matches, recordedTcgdex, setUp } from './fixtures.ts';

const recorded = recordedTcgdex();

/**
 * TCGplayer's catalog for Celebrations: each card as TCGdex has it, holofoil, plus a reverse holo of
 * Ho-Oh, a plain printing of Reshiram, and a 26th card that TCGdex doesn't list (made up, to be found).
 */
function tcgplayer(): { groups: TcgGroup[]; contents: Map<number, TcgGroupContents> } {
  const cards = (recorded.get('/sets/cel25') as { cards: { localId: string; name: string }[] }).cards;
  const products = [...cards, { localId: '26', name: 'Missingno' }].map((c, i) => ({ productId: 1000 + i, groupId: 1, name: c.localId === '26' ? 'Missingno - 26/25' : c.name, extendedData: [{ name: 'Number', value: `${c.localId}/25` }, { name: 'Rarity', value: 'Holo Rare' }] }));
  const prices = [...products.map((p) => ({ productId: p.productId, subTypeName: 'Holofoil', marketPrice: 1 })), { productId: 1000, subTypeName: 'Reverse Holofoil', marketPrice: 5 }, { productId: 1001, subTypeName: 'Normal', marketPrice: 2 }];
  return {
    groups: [
      { groupId: 1, name: 'Celebrations' },
      { groupId: 2, name: 'Celebrations: Classic Collection' },
      { groupId: 3, name: 'SV: Scarlet & Violet 151' },
    ],
    contents: new Map([
      [1, { products, prices }],
      [2, { products: [], prices: [] }],
    ]),
  };
}

const preview = async (set: string, t = setUp()) => {
  const r = await new PreviewMasterSet(t.deps).execute({ set });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

describe("a set's master set", () => {
  it('lists every card of the set and its sub-sets in every variant, in number order', async () => {
    const m = await preview('celebrations');
    matches(m, { title: 'Celebrations', setId: 'cel25', cards: 50, tcgplayer: { checked: false, error: "TCGplayer's catalog isn't used on this server." } });
    assert.equal(m.entries.length, 50);
    assert.deepEqual(
      m.entries.slice(0, 2).map((e) => [e.setId, e.number, e.name, e.variant]),
      [
        ['cel25', '1/25', 'Ho-Oh', ''],
        ['cel25', '2/25', 'Reshiram', ''],
      ],
    );
    // Its Classic Collection follows its own cards.
    assert.deepEqual(m.entries.slice(-1).map((e) => [e.setId, e.number, e.name]), [['cel25cc', 'CC025', 'Tapu Lele GX']]);
    assert.deepEqual(m.entries.filter((e) => e.extra).map((e) => e.variant), ['25th Celebration Holo', '25th Celebration Holo']);
  });

  it('names each variant so the daily price update finds that same variant', async () => {
    for (const e of (await preview('Celebrations')).entries) {
      const card = recorded.get(`/cards/${e.tcgdexId}`) as TcgdexCard;
      const chosen = chooseVariant(card, e.variant).variant;
      assert.ok(chosen, `${e.tcgdexId} ${e.variant}`);
      assert.equal(variantText(card, chosen), e.variant);
    }
  });

  it("adds the printings TCGplayer's catalog lists and TCGdex doesn't, matched to their product", async () => {
    const t = setUp({ tcgplayer: tcgplayer() });
    const m = await preview('Celebrations', t);
    assert.deepEqual(m.tcgplayer, { checked: true, added: 3, sets: ['Celebrations', 'Celebrations: Classic Collection'] });
    assert.equal(t.tcgplayer?.resets, 1);
    assert.equal(m.cards, 51);
    assert.equal(m.entries.length, 53);
    // Ho-Oh's reverse holo, after its regular card; Reshiram's plain printing (TCGdex only has its
    // holo), named so; and the card TCGdex doesn't list, in number order.
    assert.deepEqual(
      m.entries.slice(0, 4).map((e) => [e.number, e.name, e.variant, e.tcgdexId, e.tcgplayerId]),
      [
        ['1/25', 'Ho-Oh', '', 'cel25-1', null],
        ['1/25', 'Ho-Oh', 'Reverse Holo', 'cel25-1', '1000'],
        ['2/25', 'Reshiram', '', 'cel25-2', null],
        ['2/25', 'Reshiram', 'Non-Holo', 'cel25-2', '1001'],
      ],
    );
    matches(m.entries.find((e) => e.name === 'Missingno'), { setId: 'cel25', number: '26/25', variant: 'Holo', tcgdexId: null, tcgplayerId: '1025', rarity: 'Holo Rare', extra: false, thumb: 'https://tcgplayer-cdn.tcgplayer.com/product/1025_in_200x200.jpg' });
    assert.equal(m.entries.findIndex((e) => e.name === 'Missingno'), 27);
  });

  it("says when TCGplayer's catalog couldn't be checked, and still lists TCGdex's cards", async () => {
    const t = setUp({ tcgplayer: tcgplayer() });
    if (t.tcgplayer) t.tcgplayer.down = true;
    const m = await preview('Celebrations', t);
    assert.deepEqual(m.tcgplayer, { checked: false, error: "TCGplayer's catalog (tcgcsv.com) didn't answer: tcgcsv.com answered 503" });
    assert.equal(m.entries.length, 50);
  });

  it('finds the set by its id too; nothing for a set that does not exist, or one without cards', async () => {
    assert.equal((await preview('cel25')).title, 'Celebrations');
    const t = setUp();
    assert.deepEqual(await new PreviewMasterSet(t.deps).execute({ set: 'Not a set' }), { ok: false, error: { code: 'SET_NOT_FOUND', query: 'Not a set' } });
    const empty = new Map(recorded);
    empty.set('/sets', [...(recorded.get('/sets') as unknown[]), { id: 'empty1', name: 'Empty Set', cardCount: { total: 0 } }]);
    empty.set('/sets/empty1', { id: 'empty1', name: 'Empty Set', cards: [] });
    assert.deepEqual(await new PreviewMasterSet(setUp({ answers: empty }).deps).execute({ set: 'Empty Set' }), { ok: false, error: { code: 'SET_HAS_NO_CARDS', title: 'Empty Set' } });
  });

  it("offers TCGdex's English sets, without TCG Pocket's", async () => {
    const r = await new ListMasterSetSets(setUp().deps).execute();
    assert.ok(r.ok);
    assert.ok(r.value.sets.some((x) => x.id === 'cel25' && x.name === 'Celebrations' && x.total === 25));
    assert.equal(r.value.sets.some((x) => /^(?:[AB]\d+[a-z]?|P-[AB])$/.test(x.id)), false);
  });

  it("says when the card database didn't answer", async () => {
    const t = setUp();
    t.database.down = true;
    assert.deepEqual(await new PreviewMasterSet(t.deps).execute({ set: '151' }), { ok: false, error: { code: 'CARD_DATABASE_UNAVAILABLE', message: "Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND api.tcgdex.net" } });
    assert.equal((await new ListMasterSetSets(t.deps).execute()).ok, false);
  });
});

describe('making a master set', () => {
  const input = { actor: 'justin', set: 'Celebrations', owner: 'Maiya', name: 'Celebrations master set', color: null, pockets: 9, extras: false };

  it('makes a binder of placeholders filling its pages in order, leaving promo printings out unless asked', async () => {
    const t = setUp();
    t.ledger.seed('binders', 'old', { name: 'Binder 1', pockets: 9, order: 3 });
    const r = await new CreateMasterSet(t.deps).execute(input);
    assert.ok(r.ok);
    matches(r.value, { cards: 48, pages: 6 });
    matches(t.ledger.tables.binders.get(r.value.binderId), { name: 'Celebrations master set', color: null, pockets: 9, kind: 'binder', owner: 'Maiya', order: 4, createdAt: t.clock.at.toISOString() });
    const cards = [...t.ledger.tables.cards.values()];
    assert.equal(cards.length, 48);
    assert.ok(cards.every((c) => c['owner'] === 'Maiya' && c['placeholder'] === true && c['binderId'] === r.value.binderId));
    assert.equal(new Set(cards.map((c) => `${c['page']}/${c['slot']}`)).size, 48);
    matches(cards[0], {
      name: 'Ho-Oh',
      set: 'Celebrations',
      number: '1/25',
      variant: '',
      language: 'English',
      page: 1,
      slot: 1,
      status: 'binder',
      details: { source: 'tcgdex', result: 'complete', v: DETAILS_VERSION, id: 'cel25-1', chosen: true },
    });
    assert.deepEqual(cards.slice(8, 11).map((c) => [c['page'], c['slot']]), [
      [1, 9],
      [2, 1],
      [2, 2],
    ]);
    // Saved together, and sent to open pages: the binder, then its cards.
    assert.equal(t.published.length, 49);
    assert.deepEqual(t.logged.app, ['justin made a Celebrations master set: Celebrations master set, 48 placeholders (50 cards)']);
    const all = await new CreateMasterSet(t.deps).execute({ ...input, name: 'Celebrations everything', extras: true, pockets: 16 });
    assert.ok(all.ok);
    matches(all.value, { cards: 50, pages: 4 });
  });

  it("matches the printings only TCGplayer lists to TCGplayer's product", async () => {
    const t = setUp({ tcgplayer: tcgplayer() });
    const r = await new CreateMasterSet(t.deps).execute({ ...input, owner: 'Megan' });
    assert.ok(r.ok);
    assert.equal(r.value.cards, 51);
    const cards = [...t.ledger.tables.cards.values()];
    matches(cards[1], { variant: 'Reverse Holo', details: { id: 'cel25-1' }, pricing: { source: 'tcgplayer', id: '1000', linkedBy: 'auto', title: 'Ho-Oh [Reverse Holo]' } });
    matches(cards.find((c) => c['name'] === 'Missingno'), { details: null, pricing: { source: 'tcgplayer', id: '1025' } });
    assert.equal(cards.filter((c) => (c['pricing'] as { source?: string } | undefined)?.source === 'tcgplayer').length, 3);
    assert.deepEqual(t.logged.app, ['justin made a Celebrations master set: Celebrations master set, 51 placeholders (51 cards, 3 printings from TCGplayer)']);
  });

  it('makes nothing for an owner the ledger does not know, or a set that does not exist', async () => {
    const t = setUp();
    const r = await new CreateMasterSet(t.deps).execute({ ...input, owner: 'Someone' });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, 'INVALID_DOCUMENT');
    assert.deepEqual(await new CreateMasterSet(t.deps).execute({ ...input, set: 'Not a set' }), { ok: false, error: { code: 'SET_NOT_FOUND', query: 'Not a set' } });
    assert.equal(t.ledger.tables.binders.size, 0);
    assert.equal(t.ledger.tables.cards.size, 0);
    assert.deepEqual(t.published, []);
    assert.deepEqual(t.logged.app, []);
  });
});
