import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BackfillDetails } from '#application/catalog/backfill-details.ts';
import { FillEveryCard } from '#application/catalog/fill-every-card.ts';
import { ChooseMatch } from '#application/catalog/choose-match.ts';
import { FillCardDetails } from '#application/catalog/fill-card-details.ts';
import { LookUpCard } from '#application/catalog/look-up-card.ts';
import { RefreshJapaneseCatalog } from '#application/catalog/refresh-japanese-catalog.ts';
import { SearchAnyCard } from '#application/catalog/search-any-card.ts';
import { ShowAnyCard } from '#application/catalog/show-any-card.ts';
import { ShowAnyCardDetails } from '#application/catalog/show-any-card-details.ts';
import type { TcgGroup, TcgGroupContents } from '#domain/catalog/tcgplayer.ts';
import { SourceUnavailable } from '#application/catalog/ports.ts';
import { MemoryTcgplayerCatalog } from '#infrastructure/memory/catalog.ts';
import { cardOf, matches, NOW, setUp } from './fixtures.ts';

const GROUPS: TcgGroup[] = [
  { groupId: 2, name: 'SV2a: Pokemon Card 151', abbreviation: 'SV2a', publishedOn: '2023-06-16T00:00:00', modifiedOn: 'm1' },
  { groupId: 3, name: 'SV-P: Promo Pack', abbreviation: 'SV-P', publishedOn: '2024-01-01T00:00:00', modifiedOn: 'm1' },
];
const num = (value: string, rarity?: string) => [{ name: 'Number', value }, ...(rarity ? [{ name: 'Rarity', value: rarity }] : [])];
const CONTENTS = new Map<number, TcgGroupContents>([
  [2, {
    products: [
      { productId: 222, groupId: 2, name: 'Charizard ex - 201/165', extendedData: num('201/165', 'Special Art Rare') },
      { productId: 223, groupId: 2, name: 'Pikachu - 025/165', extendedData: num('025/165', 'Common') },
      { productId: 224, groupId: 2, name: 'Booster Box', extendedData: [] },
    ],
    prices: [{ productId: 223, subTypeName: 'Normal', marketPrice: 2 }, { productId: 223, subTypeName: 'Reverse Holofoil', marketPrice: 6 }],
  }],
  [3, { products: [{ productId: 333, groupId: 3, name: 'Pikachu - 001/SV-P', extendedData: num('001/SV-P', 'Promo') }], prices: [] }],
]);
const TCGDEX_JA = new Map<string, unknown>([['/cards/SV2a-025', { id: 'SV2a-025', localId: '025', name: 'Pikachu', illustrator: ' Atsuko Nishida ', set: { id: 'SV2a', name: '151' } }]]);

const japanese = () => setUp({ japanese: { groups: GROUPS, contents: CONTENTS, answers: TCGDEX_JA } });
type T = ReturnType<typeof japanese>;
const jp = (t: T) => {
  if (!t.deps.japanese) throw new Error('no Japanese lookups');
  return t.deps.japanese;
};
const refresher = (t: T, extra: { afterFirstBuild?: () => void } = {}) => new RefreshJapaneseCatalog({ ...t.deps, ...extra });
/** A built index, as if the first build had finished. */
async function built(t: T) {
  await refresher(t).execute();
  return t;
}

describe('building the Japanese card index', () => {
  it('downloads every set on the first build, saves, and calls afterFirstBuild once', async () => {
    const t = japanese();
    let calls = 0;
    const r = refresher(t, { afterFirstBuild: () => void calls++ });
    assert.deepEqual(await r.execute(), { fetched: 2, dropped: 0, failed: false });
    assert.deepEqual(t.japaneseTcgplayer?.productsAsked, [3, 2]);
    assert.equal(jp(t).catalog.completedAt, NOW.toISOString());
    assert.equal(jp(t).catalog.cardCount(), 3);
    assert.equal(t.japaneseStore.saved?.completedAt, NOW.toISOString());
    assert.deepEqual(t.scheduler.pauses, [1000, 1000]);
    assert.equal(t.japaneseTcgplayer?.resets, 1);
    await r.execute();
    assert.equal(calls, 1);
  });

  it('downloads only changed sets afterwards, and schedules the next run at 21:00 UTC', async () => {
    const t = japanese();
    const r = refresher(t);
    await r.execute();
    const before = t.japaneseTcgplayer?.productLists;
    assert.deepEqual(await r.execute(), { fetched: 0, dropped: 0, failed: false });
    assert.equal(t.japaneseTcgplayer?.productLists, before);
    const tcgplayer = new MemoryTcgplayerCatalog(GROUPS.map((g) => (g.groupId === 3 ? { ...g, modifiedOn: 'm2' } : g)), CONTENTS);
    const changed = new RefreshJapaneseCatalog({ ...t.deps, japanese: { ...jp(t), tcgplayer } });
    assert.deepEqual(await changed.execute(), { fetched: 1, dropped: 0, failed: false });
    assert.deepEqual(t.scheduler.waiting.at(-1), Date.parse('2026-10-03T21:00:00Z') - NOW.getTime());
  });

  it('stops when told, downloading and scheduling nothing more', async () => {
    const t = japanese();
    const r = refresher(t);
    const first = r.execute();
    r.stop();
    const done = await first;
    assert.ok(done.fetched < 2);
    assert.equal(jp(t).catalog.completedAt, null);
    assert.deepEqual(t.scheduler.waiting, []);
    assert.deepEqual(await r.execute(), { fetched: 0, dropped: 0, failed: false });
  });

  it('keeps the old index and tries again in an hour when TCGplayer does not answer', async () => {
    const t = await built(japanese());
    const old = jp(t).catalog.data();
    if (t.japaneseTcgplayer) t.japaneseTcgplayer.down = true;
    const r = refresher(t);
    assert.equal((await r.execute()).failed, true);
    assert.deepEqual(jp(t).catalog.data(), old);
    assert.match(t.logged.warn.join('\n'), /Japanese card index: tcgcsv\.com answered 503|503/);
    assert.deepEqual(t.scheduler.waiting.at(-1), RefreshJapaneseCatalog.retryAfterMs);
  });

  it('skips a set whose products fail, stores the others, completes, and fetches the skipped set at the next run', async () => {
    const t = japanese();
    const tcgplayer = t.japaneseTcgplayer;
    if (!tcgplayer) throw new Error('no catalog');
    const real = tcgplayer.products.bind(tcgplayer);
    let broken = true;
    tcgplayer.products = async (id: number) => {
      if (broken && id === 3) throw new SourceUnavailable('tcgcsv.com sent no results');
      return real(id);
    };
    const r = refresher(t);
    assert.deepEqual(await r.execute(), { fetched: 1, dropped: 0, failed: false });
    assert.equal(jp(t).catalog.completedAt, NOW.toISOString());
    assert.deepEqual(jp(t).catalog.sets().map((s) => s.groupId), [2]);
    assert.match(t.logged.warn.join('\n'), /1 sets skipped/);
    broken = false;
    assert.deepEqual(await r.execute(), { fetched: 1, dropped: 0, failed: false });
    assert.deepEqual(jp(t).catalog.sets().map((s) => s.groupId).sort(), [2, 3]);
  });

  it('fails the run when several sets in a row fail, as when the source is down', async () => {
    const t = japanese();
    const tcgplayer = t.japaneseTcgplayer;
    if (!tcgplayer) throw new Error('no catalog');
    const groups = [1, 2, 3, 4].map((id) => ({ groupId: id, name: `S${id}`, modifiedOn: 'm' }));
    const down = new MemoryTcgplayerCatalog(groups, new Map());
    down.products = async () => {
      throw new SourceUnavailable('Skipped: tcgcsv.com kept failing');
    };
    const r = new RefreshJapaneseCatalog({ ...t.deps, japanese: { ...jp(t), tcgplayer: down } });
    assert.equal((await r.execute()).failed, true);
    assert.equal(jp(t).catalog.completedAt, null);
  });

  it('keeps the index when the list of sets comes back empty', async () => {
    const t = await built(japanese());
    const old = jp(t).catalog.data();
    const empty = new MemoryTcgplayerCatalog([], new Map());
    const r = new RefreshJapaneseCatalog({ ...t.deps, japanese: { ...jp(t), tcgplayer: empty } });
    assert.deepEqual(await r.execute(), { fetched: 0, dropped: 0, failed: true });
    assert.deepEqual(jp(t).catalog.data(), old);
    assert.deepEqual(t.scheduler.waiting.at(-1), RefreshJapaneseCatalog.retryAfterMs);
  });

  it('rebuilds when the saved index is missing or damaged, and loads one that is there', async () => {
    const t = japanese();
    t.japaneseStore.failLoad = true;
    refresher(t).start();
    await new Promise((r) => setImmediate(r));
    assert.match(t.logged.warn.join('\n'), /couldn't read the saved index/);
    assert.deepEqual(t.scheduler.waiting, [RefreshJapaneseCatalog.firstRunAfterMs]);

    const fresh = japanese();
    refresher(fresh).start();
    await new Promise((r) => setImmediate(r));
    assert.match(fresh.logged.info.join('\n'), /rebuilding it/);

    const done = await built(japanese());
    const again = setUp({ japanese: { groups: GROUPS, contents: CONTENTS } });
    await again.japaneseStore.save(jp(done).catalog.data());
    again.clock.at = new Date('2026-10-03T13:00:00Z');
    const r = refresher(again);
    r.start();
    await new Promise((r2) => setImmediate(r2));
    assert.equal(jp(again).catalog.cardCount(), 3);
    assert.deepEqual(again.scheduler.waiting, [Date.parse('2026-10-03T21:00:00Z') - again.clock.at.getTime()]);
  });

  it('does nothing without Japanese lookups', async () => {
    const t = setUp();
    const r = refresher(t);
    r.start();
    assert.deepEqual(await r.execute(), { fetched: 0, dropped: 0, failed: false });
    assert.deepEqual(t.scheduler.waiting, []);
  });
});

describe('looking up a Japanese card', () => {
  it('says how far the first build is while it has not finished, and nothing for English', async () => {
    const t = japanese();
    jp(t).catalog.progress = { running: true, done: 0, total: 462 };
    const look = new LookUpCard(t.deps);
    assert.deepEqual(await look.execute({ name: 'Pikachu', number: '25', language: 'ja' }), { ok: false, error: { code: 'JAPANESE_CATALOG_NOT_READY', done: 0, total: 462 } });
    const r = await look.execute({ name: 'Pikachu', number: '51/162', language: 'en' });
    assert.ok(r.ok && r.value.matches.length === 1);
  });

  it('does not look a card up in a partial index, but says how far the build is', async () => {
    const t = await built(japanese());
    jp(t).catalog.completedAt = null;
    jp(t).catalog.progress = { running: true, done: 1, total: 2 };
    assert.deepEqual(await new LookUpCard(t.deps).execute({ name: 'Pikachu', number: '25/165', language: 'ja' }), { ok: false, error: { code: 'JAPANESE_CATALOG_NOT_READY', done: 1, total: 2 } });
  });

  it('is off without a Japanese catalog', async () => {
    const t = setUp();
    assert.deepEqual(await new LookUpCard(t.deps).execute({ name: 'Pikachu', number: '25', language: 'ja' }), { ok: false, error: { code: 'JAPANESE_LOOKUPS_OFF' } });
  });

  it('finds the card, with the illustrator from TCGdex when exactly one matches', async () => {
    const t = await built(japanese());
    const r = await new LookUpCard(t.deps).execute({ name: 'Pikachu', number: '25/165', language: 'ja' });
    assert.ok(r.ok);
    matches(r.value.matches, [{ id: 'ja-2-223', set: 'Pokemon Card 151', setCode: 'SV2a', rarity: 'Common', artist: 'Atsuko Nishida', released: '2023-06-16' }]);
    assert.equal(r.value.matches.length, 1);
  });
});

describe('filling in a Japanese card', () => {
  const card = { name: 'Pikachu', number: '025/165', language: 'Japanese' };

  it('fills the set, code, rarity, illustrator and release date, and records the Japanese id', async () => {
    const t = await built(japanese());
    t.ledger.seed('cards', 'a', card);
    assert.equal(await new FillCardDetails(t.deps).execute({ cardId: 'a' }), 'filled');
    matches(cardOf(t.ledger, 'a'), {
      set: 'Pokemon Card 151', setCode: 'SV2a', rarity: 'Common', artist: 'Atsuko Nishida', released: '2023-06-16',
      details: { result: 'filled', id: 'ja-2-223', setId: 'ja-2' },
    });
  });

  it('looks a card up again when its recorded match is an English one, even if nothing is blank', async () => {
    const t = await built(japanese());
    const full = { ...card, set: 'Pokemon Card 151', setCode: 'SV2a', rarity: 'Common', artist: 'Atsuko Nishida', released: '2023-06-16' };
    t.ledger.seed('cards', 'a', { ...full, details: { source: 'tcgdex', result: 'complete', v: 3, id: 'sv05-051', checkedAt: NOW.toISOString() } });
    assert.equal(await new FillCardDetails(t.deps).execute({ cardId: 'a' }), 'complete');
    matches(cardOf(t.ledger, 'a'), { details: { id: 'ja-2-223' } });
  });

  it('skips a card, recording nothing, while the first build has not finished', async () => {
    const t = japanese();
    t.ledger.seed('cards', 'a', card);
    assert.equal(await new FillCardDetails(t.deps).execute({ cardId: 'a' }), 'skipped');
    assert.equal(cardOf(t.ledger, 'a')['details'], undefined);
    assert.deepEqual(t.published, []);
  });

  it('skips a card, recording nothing, while the index is only partly built', async () => {
    const t = await built(japanese());
    jp(t).catalog.completedAt = null;
    t.ledger.seed('cards', 'a', card);
    assert.equal(await new FillCardDetails(t.deps).execute({ cardId: 'a' }), 'skipped');
    assert.equal(cardOf(t.ledger, 'a')['details'], undefined);
    assert.deepEqual(t.published, []);
    jp(t).catalog.completedAt = NOW.toISOString();
    assert.equal(await new FillCardDetails(t.deps).execute({ cardId: 'a' }), 'filled');
  });

  it('leaves English cards as they were, and skips other languages', async () => {
    const t = await built(japanese());
    t.ledger.seed('cards', 'e', { name: 'Pikachu', number: '51/162' });
    t.ledger.seed('cards', 'k', { ...card, language: 'Korean' });
    assert.equal(await new FillCardDetails(t.deps).execute({ cardId: 'e' }), 'filled');
    assert.equal(cardOf(t.ledger, 'e')['setCode'], 'TEF');
    assert.equal(await new FillCardDetails(t.deps).execute({ cardId: 'k' }), 'skipped');
  });

  it('refuses a match from the other language', async () => {
    const t = await built(japanese());
    t.ledger.seed('cards', 'j', card);
    t.ledger.seed('cards', 'e', { name: 'Pikachu', number: '51/162' });
    const choose = new ChooseMatch({ ...t.deps, fillCard: new FillCardDetails(t.deps) });
    assert.deepEqual(await choose.execute({ cardId: 'e', matchId: 'ja-2-223' }), { ok: false, error: { code: 'WRONG_LANGUAGE' } });
    assert.deepEqual(await choose.execute({ cardId: 'j', matchId: 'sv05-051' }), { ok: false, error: { code: 'WRONG_LANGUAGE' } });
    const ok = await choose.execute({ cardId: 'j', matchId: 'ja-2-223' });
    assert.ok(ok.ok && ok.value.result === 'filled');
    assert.deepEqual(await new ChooseMatch({ ...setUp().deps, fillCard: new FillCardDetails(t.deps) }).execute({ cardId: 'nope', matchId: 'ja-2-223' }), { ok: false, error: { code: 'CARD_NOT_FOUND' } });
  });
});

describe('Find a card for Japanese cards', () => {
  it('finds a card by its English name alone, and a set code narrows it', async () => {
    const t = await built(japanese());
    const search = new SearchAnyCard(t.deps);
    const all = await search.execute({ query: 'pikachu', language: 'ja' });
    assert.ok(all.ok);
    assert.deepEqual(all.value.hits.map((h) => h.id), ['ja-3-333', 'ja-2-223']);
    const narrow = await search.execute({ query: 'pikachu sv2a', language: 'ja' });
    assert.ok(narrow.ok);
    assert.deepEqual(narrow.value.hits.map((h) => h.id), ['ja-2-223']);
  });

  it('searches a partial index so people can browse while the first build runs', async () => {
    const t = await built(japanese());
    jp(t).catalog.completedAt = null;
    const r = await new SearchAnyCard(t.deps).execute({ query: 'pikachu', language: 'ja' });
    assert.ok(r.ok);
    assert.deepEqual(r.value.hits.map((h) => h.id), ['ja-3-333', 'ja-2-223']);
  });

  it('answers not ready or off like a lookup', async () => {
    assert.deepEqual(await new SearchAnyCard(japanese().deps).execute({ query: 'pikachu', language: 'ja' }), { ok: false, error: { code: 'JAPANESE_CATALOG_NOT_READY', done: 0, total: 0 } });
    assert.deepEqual(await new SearchAnyCard(setUp().deps).execute({ query: 'pikachu', language: 'ja' }), { ok: false, error: { code: 'JAPANESE_LOOKUPS_OFF' } });
  });

  it("shows a card's details, and its printings priced from TCGplayer's group with the saved rate", async () => {
    const t = await built(japanese());
    const details = await new ShowAnyCardDetails(t.deps).execute({ id: 'ja-2-223', language: 'ja' });
    assert.ok(details.ok);
    matches(details.value, { id: 'ja-2-223', name: 'Pikachu', number: '025', total: 165, setCode: 'SV2a', artist: 'Atsuko Nishida', printings: [{ label: 'regular', variant: '' }] });
    const shown = await new ShowAnyCard(t.deps).execute({ id: 'ja-2-223', language: 'ja' });
    assert.ok(shown.ok);
    assert.deepEqual(shown.value.printings.map((p) => [p.label, p.variant, p.price?.usd, p.price?.cad]), [['regular', '', 2, 2.74], ['reverse holo', 'Reverse Holo', 6, 8.22]]);
    assert.equal(shown.value.printings[0]?.pricecharting, null);
    assert.equal(shown.value.printings[0]?.tcgplayer?.url, 'https://www.tcgplayer.com/product/223');
    assert.equal(shown.value.rates.usd, 1.37);
    assert.equal(shown.value.notes.length, 1);
    assert.deepEqual(await new ShowAnyCard(t.deps).execute({ id: 'ja-2-999', language: 'ja' }), { ok: false, error: { code: 'NO_SUCH_CARD' } });
  });
});

describe('a Japanese card holding an English match', () => {
  const full = { name: 'Pikachu', number: '025/165', language: 'Japanese', set: 'Pokemon Card 151', setCode: 'SV2a', rarity: 'Common', artist: 'Atsuko Nishida', released: '2023-06-16' };
  const english = { source: 'tcgdex', result: 'complete', v: 3, id: 'sv05-051', checkedAt: NOW.toISOString() };

  it('is skipped during the first build, then picked up by the backfill and the daily run', async () => {
    const t = japanese();
    t.ledger.seed('cards', 'a', { ...full, details: english });
    const fillCard = new FillCardDetails(t.deps);
    assert.equal(await fillCard.execute({ cardId: 'a' }), 'skipped');
    matches(cardOf(t.ledger, 'a'), { details: { id: 'sv05-051' } });
    await refresher(t).execute();
    const fillEvery = new FillEveryCard({ ...t.deps, fillCard });
    const backfill = new BackfillDetails({ ...t.deps, fillEvery });
    assert.equal(await backfill.execute(), 1);
    await fillEvery.finished();
    matches(cardOf(t.ledger, 'a'), { details: { id: 'ja-2-223' } });
    assert.equal((await fillEvery.execute()).cards, 0);
  });

  it('is selected by the daily run without force', async () => {
    const t = await built(japanese());
    t.ledger.seed('cards', 'a', { ...full, details: english });
    const fillEvery = new FillEveryCard({ ...t.deps, fillCard: new FillCardDetails(t.deps) });
    assert.equal((await fillEvery.execute()).cards, 1);
    await fillEvery.finished();
    matches(cardOf(t.ledger, 'a'), { details: { id: 'ja-2-223' } });
  });
});

describe('choosing a match for a Japanese card before the catalog is ready', () => {
  it('answers not ready, applying nothing; other skips stay ok', async () => {
    const t = japanese();
    t.ledger.seed('cards', 'j', { name: 'Pikachu', number: '025/165', language: 'Japanese' });
    const choose = new ChooseMatch({ ...t.deps, fillCard: new FillCardDetails(t.deps) });
    const r = await choose.execute({ cardId: 'j', matchId: 'ja-2-223' });
    assert.ok(!r.ok && r.error.code === 'JAPANESE_CATALOG_NOT_READY');
    assert.equal(cardOf(t.ledger, 'j')['details'], undefined);
  });
});
