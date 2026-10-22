import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SearchAnyCard } from '#application/catalog/search-any-card.ts';
import { ShowAnyCard } from '#application/catalog/show-any-card.ts';
import type { TcgdexCard } from '#domain/catalog/tcgdex.ts';
import { matches, setUp } from './fixtures.ts';

const CHARIZARD = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../fixtures/tcgdex-charizard.json'), 'utf8')) as TcgdexCard;

// A small TCGdex: a few sets (oldest first, as TCGdex lists them), one of them TCG Pocket's.
const SETS = [
  { id: 'base1', name: 'Base Set', cardCount: { official: 102 } },
  { id: 'base4', name: 'Base Set 2', cardCount: { official: 130 } },
  { id: 'A1', name: 'Genetic Apex', cardCount: { official: 226 } },
  { id: 'sv03.5', name: '151', cardCount: { official: 165 } },
  { id: 'swshp', name: 'SWSH Black Star Promos', cardCount: { official: 307 } },
  { id: '30th', name: '30th Celebration', cardCount: { official: 128 } },
  { id: '30th-c', name: '30th Classic Collection', cardCount: { official: 25 } },
];
const img = (set: string, n: string) => `https://assets.tcgdex.net/en/x/${set}/${n}`;
const CARDS = [
  { id: 'base1-4', localId: '4', name: 'Charizard', image: img('base1', '4') },
  { id: 'base4-4', localId: '4', name: 'Charizard', image: img('base4', '4') },
  { id: 'A1-36', localId: '36', name: 'Charizard', image: img('A1', '36') },
  { id: 'sv03.5-006', localId: '006', name: 'Charizard ex', image: img('sv03.5', '006') },
  { id: 'sv03.5-199', localId: '199', name: 'Charizard ex' },
  { id: 'swshp-SWSH050', localId: 'SWSH050', name: 'Charizard V' },
  { id: 'sv03.5-151', localId: '151', name: 'Charizard' },
];

/** TCGdex as it answers: searches by part of a name or number, and the cards and sets it has. */
function tcgdex(p: string): unknown {
  const q = new URL(p, 'https://api.tcgdex.net').searchParams;
  if (p.startsWith('/cards?name=')) return CARDS.filter((c) => c.name.toLowerCase().includes(String(q.get('name')).toLowerCase()));
  if (p.startsWith('/cards?localId=')) return CARDS.filter((c) => c.localId.toLowerCase().includes(String(q.get('localId')).toLowerCase()));
  const routes: Record<string, unknown> = {
    '/sets': SETS,
    '/series/tcgp': { sets: [{ id: 'A1' }] },
    '/sets/base1': { id: 'base1', name: 'Base Set', releaseDate: '1999-01-09', abbreviation: { official: 'BS' } },
    '/cards/base1-4': CHARIZARD,
    // A reprint in a sub-set, which PriceCharting lists under the set it belongs to.
    '/cards/30th-c-4': { ...CHARIZARD, id: '30th-c-4', set: { id: '30th-c', name: '30th Classic Collection', cardCount: { official: 25 } } },
    '/cards/plain-1': { id: 'plain-1', localId: '1', name: 'Plain', set: { id: 'plain', name: 'Plain' }, pricing: { tcgplayer: { normal: { productId: 77, marketPrice: 1 } } } },
  };
  return routes[p];
}

const search = async (query: string, t = setUp({ answers: tcgdex })) => {
  const r = await new SearchAnyCard(t.deps).execute({ query });
  assert.ok(r.ok);
  return r.value;
};
const ids = async (query: string) => (await search(query)).hits.map((h) => h.id);

describe('searching for any card', () => {
  it('finds cards by name, exact names first and newest sets first, leaving out TCG Pocket', async () => {
    const { hits, more } = await search('charizard');
    assert.equal(more, false);
    assert.deepEqual(
      hits.map((h) => h.id),
      ['sv03.5-151', 'base4-4', 'base1-4', 'swshp-SWSH050', 'sv03.5-006', 'sv03.5-199'],
    );
    assert.deepEqual(hits[2], { id: 'base1-4', name: 'Charizard', number: '4', total: 102, set: 'Base Set', thumb: `${img('base1', '4')}/low.webp` });
    assert.equal(hits[5]?.thumb, null);
  });

  it('narrows by set words and number, wherever they are in the query', async () => {
    assert.deepEqual(await ids('charizard base set 2'), ['base4-4']);
    assert.deepEqual(await ids('base set charizard 4/102'), ['base1-4']);
    assert.deepEqual(await ids('Charizard ex 6'), ['sv03.5-006']);
    // A number can be the card's number or in its set's name: the card's number first.
    assert.deepEqual(await ids('charizard 151'), ['sv03.5-151', 'sv03.5-006', 'sv03.5-199']);
    // The set named exactly first.
    assert.deepEqual(await ids('charizard base set'), ['base1-4', 'base4-4']);
    assert.deepEqual(await ids('charizard jungle'), []);
  });

  it('finds a name among several set and printing words, without searching for the printing words', async () => {
    const t = setUp({ answers: tcgdex });
    assert.deepEqual((await search('charizard base set holo', t)).hits.map((h) => h.id), ['base1-4', 'base4-4']);
    assert.deepEqual((await search('base set 2 unlimited charizard', t)).hits.map((h) => h.id), ['base4-4']);
    assert.equal(t.database.asked.some((c) => /holo|unlimited/.test(c)), false);
  });

  it('leaves out "pokemon" and "card" beside other words, and searches nothing for printing words alone', async () => {
    assert.deepEqual(await ids('pokemon charizard base set 2 card'), ['base4-4']);
    assert.ok((await ids('charizard pokemon')).includes('base1-4'));
    const t = setUp({ answers: tcgdex });
    assert.deepEqual(await search('1st edition holo', t), { hits: [], more: false });
    assert.deepEqual(t.database.asked, []);
  });

  it('finds every card with a number when only a number is typed', async () => {
    assert.deepEqual(await ids('4/130'), ['base4-4']);
    assert.deepEqual(await ids('swsh050'), ['swshp-SWSH050']);
  });

  it('asks TCGdex only a few times for words that name nothing', async () => {
    const t = setUp({ answers: tcgdex });
    // At most 6 runs of several words, then each word of 3 letters or more on its own.
    assert.deepEqual((await search('zzz qq ww ee rr tt', t)).hits, []);
    assert.equal(t.database.asked.filter((c) => c.startsWith('/cards?')).length, 7);
  });

  it("says when the card database didn't answer", async () => {
    const t = setUp({ answers: tcgdex });
    t.database.down = true;
    assert.deepEqual(await new SearchAnyCard(t.deps).execute({ query: 'pikachu' }), { ok: false, error: { code: 'CARD_DATABASE_UNAVAILABLE', message: "Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND api.tcgdex.net" } });
  });
});

describe("one card's details and printings", () => {
  const show = async (id: string, t = setUp({ answers: tcgdex })) => new ShowAnyCard(t.deps).execute({ id });

  it('gives its details, and its printings priced the way the daily update would', async () => {
    const t = setUp({ answers: tcgdex });
    const r = await show('base1-4', t);
    assert.ok(r.ok);
    matches(r.value, { id: 'base1-4', name: 'Charizard', number: '4', total: 102, set: 'Base Set', setCode: 'BS', rarity: 'Rare', artist: 'Mitsuhiro Arita', released: '1999-01-09', image: 'https://assets.tcgdex.net/en/base/base1/4/high.webp', rates: { usd: 1.37, eur: null }, notes: [] });
    assert.deepEqual(
      r.value.printings.map((p) => [p.label, p.variant]),
      [
        ['holo', 'Holo'],
        ['1st Edition Shadowless holo', '1st Edition Shadowless Holo'],
        ['Shadowless holo', 'Shadowless Holo'],
        ['1999 2000 Copyright holo', '1999 2000 Copyright Holo'],
      ],
    );
    // Asked to price with its set code and size; it's in no sub-set.
    matches(t.anyCardPricing.asked[0], { setCode: 'BS', total: 102, parentSet: null });
  });

  it("names the set a reprint sub-set's card belongs to", async () => {
    const t = setUp({ answers: tcgdex });
    assert.ok((await show('30th-c-4', t)).ok);
    matches(t.anyCardPricing.asked[0], { parentSet: '30th Celebration' });
  });

  it('pictures a card without a picture of its own by its TCGplayer product', async () => {
    const r = await show('plain-1');
    assert.ok(r.ok);
    assert.equal(r.value.image, 'https://tcgplayer-cdn.tcgplayer.com/product/77_in_1000x1000.jpg');
  });

  it("answers no such card for a card the card database doesn't have, or an id it can't have", async () => {
    assert.deepEqual(await show('no-such-card'), { ok: false, error: { code: 'NO_SUCH_CARD' } });
    assert.deepEqual(await show('bad id'), { ok: false, error: { code: 'NO_SUCH_CARD' } });
  });

  it("says when the card database didn't answer", async () => {
    const t = setUp({ answers: tcgdex });
    t.database.down = true;
    assert.deepEqual(await show('base1-4', t), { ok: false, error: { code: 'CARD_DATABASE_UNAVAILABLE', message: "Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND api.tcgdex.net" } });
  });
});
