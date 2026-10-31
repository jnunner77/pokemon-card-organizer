import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { CardDatabase } from '#application/catalog/ports.ts';
import { SearchAnyCard } from '#application/catalog/search-any-card.ts';
import { ShowAnyCard } from '#application/catalog/show-any-card.ts';
import { ShowAnyCardDetails } from '#application/catalog/show-any-card-details.ts';
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

describe('searching for any card warms the TCGplayer set list', () => {
  const warm = () => setUp({ answers: tcgdex, tcgplayer: { groups: [], contents: new Map() } });
  const lists = (t: ReturnType<typeof warm>) => t.tcgplayer?.lists;

  it('asks for it once when a search finds cards, and again only after ten minutes', async () => {
    const t = warm();
    const searching = new SearchAnyCard(t.deps);
    const found = async () => assert.ok((await searching.execute({ query: 'charizard' })).ok);
    await found();
    assert.equal(lists(t), 1);
    await found();
    assert.equal(lists(t), 1);
    t.clock.at = new Date(t.clock.at.getTime() + 11 * 60_000);
    await found();
    assert.equal(lists(t), 2);
  });

  it("doesn't ask when a search finds nothing", async () => {
    const t = warm();
    assert.deepEqual((await search('charizard jungle', t)).hits, []);
    assert.equal(lists(t), 0);
  });

  it('still answers when TCGplayer does not', async () => {
    const t = warm();
    if (t.tcgplayer) t.tcgplayer.down = true;
    assert.ok((await search('charizard', t)).hits.length > 0);
  });

  it('still answers on a server without TCGplayer', async () => {
    assert.ok((await search('charizard')).hits.length > 0);
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

  it('asks TCGdex for the set list while the card is on its way', async () => {
    const t = setUp({ answers: tcgdex });
    await show('base1-4', t);
    assert.deepEqual(t.database.asked, ['/sets', '/cards/base1-4', '/sets/base1']);
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

describe("one card's details, before its prices", () => {
  const details = async (id: string, t = setUp({ answers: tcgdex })) => new ShowAnyCardDetails(t.deps).execute({ id });

  it('gives the same details and printings as the full answer, without prices', async () => {
    const t = setUp({ answers: tcgdex });
    const r = await details('base1-4', t);
    assert.ok(r.ok);
    matches(r.value, { id: 'base1-4', name: 'Charizard', number: '4', total: 102, set: 'Base Set', setCode: 'BS', rarity: 'Rare', artist: 'Mitsuhiro Arita', released: '1999-01-09', image: 'https://assets.tcgdex.net/en/base/base1/4/high.webp' });
    const full = await new ShowAnyCard(setUp({ answers: tcgdex }).deps).execute({ id: 'base1-4' });
    assert.ok(full.ok);
    assert.deepEqual(
      r.value.printings,
      full.value.printings.map((p) => ({ label: p.label, variant: p.variant })),
    );
    assert.equal('rates' in r.value, false);
    assert.equal('notes' in r.value, false);
    assert.deepEqual(t.anyCardPricing.asked, []);
  });

  it('pictures a card without a picture of its own by its TCGplayer product', async () => {
    const r = await details('plain-1');
    assert.ok(r.ok);
    assert.equal(r.value.image, 'https://tcgplayer-cdn.tcgplayer.com/product/77_in_1000x1000.jpg');
  });

  it('answers no such card for a card the card database does not have, or an id it cannot have', async () => {
    assert.deepEqual(await details('no-such-card'), { ok: false, error: { code: 'NO_SUCH_CARD' } });
    assert.deepEqual(await details('bad id'), { ok: false, error: { code: 'NO_SUCH_CARD' } });
  });

  it("says when the card database didn't answer", async () => {
    const t = setUp({ answers: tcgdex });
    t.database.down = true;
    assert.deepEqual(await details('base1-4', t), { ok: false, error: { code: 'CARD_DATABASE_UNAVAILABLE', message: "Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND api.tcgdex.net" } });
  });
});

describe('searching for any card fetches its top result ahead', () => {
  // The recorded Base Set 2 card too, so a second top result can be fetched.
  const answers = (p: string): unknown => {
    if (p === '/cards/base4-4') return { ...CHARIZARD, id: 'base4-4', set: { id: 'base4', name: 'Base Set 2', cardCount: { official: 130 } } };
    if (p === '/sets/base4') return { id: 'base4', name: 'Base Set 2', releaseDate: '2000-02-24', abbreviation: { official: 'B2' } };
    return tcgdex(p);
  };
  const ahead = () => setUp({ answers });
  const searchFor = async (searching: SearchAnyCard, query: string) => {
    const r = await searching.execute({ query });
    assert.ok(r.ok);
    await searching.idle();
    return r.value;
  };

  it('fetches only the top result and its set, and not again within ten minutes', async () => {
    const t = ahead();
    const searching = new SearchAnyCard(t.deps);
    const { hits } = await searchFor(searching, 'charizard base set 4');
    assert.equal(hits[0]?.id, 'base1-4');
    assert.ok(t.database.asked.includes('/cards/base1-4'));
    assert.ok(t.database.asked.includes('/sets/base1'));
    assert.ok(!t.database.asked.includes('/cards/base4-4'));
    assert.equal(t.anyCardPricing.warmed.length, 1);
    const warmed = t.anyCardPricing.warmed[0];
    assert.equal(warmed?.card.id, 'base1-4');
    assert.equal(warmed?.setCode, 'BS');
    assert.equal(warmed?.total, 102);

    await searchFor(searching, 'charizard base set 4');
    assert.equal(t.anyCardPricing.warmed.length, 1);
    // Another top result is fetched too.
    await searchFor(searching, 'charizard base set 2');
    assert.deepEqual(
      t.anyCardPricing.warmed.map((w) => w.card.id),
      ['base1-4', 'base4-4'],
    );
    // The same one again after ten minutes.
    t.clock.at = new Date(t.clock.at.getTime() + 11 * 60_000);
    await searchFor(searching, 'charizard base set 2');
    assert.equal(t.anyCardPricing.warmed.length, 3);
  });

  it('fetches nothing when a search finds nothing', async () => {
    const t = ahead();
    await searchFor(new SearchAnyCard(t.deps), 'charizard jungle');
    assert.equal(t.anyCardPricing.warmed.length, 0);
  });

  it('still answers when the top result is not found, and tries it again next time', async () => {
    const t = ahead();
    const searching = new SearchAnyCard(t.deps);
    // Its card is not in TCGdex's answers.
    assert.equal((await searchFor(searching, 'charizard')).hits[0]?.id, 'sv03.5-151');
    assert.equal(t.anyCardPricing.warmed.length, 0);
    const asks = () => t.database.asked.filter((p) => p === '/cards/sv03.5-151').length;
    const before = asks();
    await searchFor(searching, 'charizard');
    assert.equal(asks(), before + 1);
  });

  it('still answers when pricing could not fetch, and tries it again next time', async () => {
    const t = ahead();
    t.anyCardPricing.warmFails = true;
    const searching = new SearchAnyCard(t.deps);
    assert.equal((await searchFor(searching, 'charizard base set 4')).hits[0]?.id, 'base1-4');
    await searchFor(searching, 'charizard base set 4');
    assert.equal(t.anyCardPricing.warmed.length, 2);
  });

  it('answers without waiting for it', async () => {
    const t = ahead();
    t.anyCardPricing.hold = new Promise(() => undefined);
    const r = await new SearchAnyCard(t.deps).execute({ query: 'charizard base set 4' });
    assert.ok(r.ok && r.value.hits.length > 0);
  });

  it('asks the first search before the set list answers', async () => {
    const t = ahead();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const db = t.deps.database;
    const gated: CardDatabase = {
      cardsNamed: (n) => db.cardsNamed(n),
      cardsNumbered: (n) => db.cardsNumbered(n),
      card: (id) => db.card(id),
      set: (id) => db.set(id),
      sets: async () => {
        await gate;
        return db.sets();
      },
      setsNamed: (n) => db.setsNamed(n),
      pocketSets: () => db.pocketSets(),
    };
    const pending = new SearchAnyCard({ ...t.deps, database: gated }).execute({ query: 'charizard' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(t.database.asked.some((p) => p.startsWith('/cards?name=')));
    assert.ok(!t.database.asked.includes('/sets'));
    open();
    assert.ok((await pending).ok);
  });
});
