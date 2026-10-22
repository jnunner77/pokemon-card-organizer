import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutofillCard } from '#application/catalog/autofill-card.ts';
import { BackfillDetails } from '#application/catalog/backfill-details.ts';
import { FillCardDetails } from '#application/catalog/fill-card-details.ts';
import { FillEveryCard } from '#application/catalog/fill-every-card.ts';
import { WatchNewCards } from '#application/catalog/watch-new-cards.ts';
import { DETAILS_VERSION } from '#domain/cards/attention.ts';
import { cardOf, matches, setUp } from './fixtures.ts';

type T = ReturnType<typeof setUp>;

/** New cards filling themselves in, Fill in missing details and the backfill after an update. */
function autofill(t: T, backfillAfterMs: number | null = null) {
  const fillCard = new FillCardDetails(t.deps);
  const fillEvery = new FillEveryCard({ ...t.deps, fillCard });
  const backfill = new BackfillDetails({ ...t.deps, fillEvery });
  const watch = new WatchNewCards({ ...t.deps, autofill: new AutofillCard({ ...t.deps, fillCard }), backfill }, { backfillAfterMs });
  return { fillEvery, backfill, watch };
}

/** A card saved (whole), as the ledger tells the watch about it. */
const save = (t: T, id: string, card: Record<string, unknown>) => {
  t.ledger.seed('cards', id, card);
  t.changes.emit({ kind: 'card', id, card });
};
const update = (t: T, id: string, patch: Record<string, unknown>) => save(t, id, { ...cardOf(t.ledger, id), ...patch });
/** Let background work that was just started get going. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('new cards fill themselves in', () => {
  it('looks up the details, then the price and picture, of each new card', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'old', { name: 'Pikachu', number: '51/162' });
    const { watch } = autofill(t);
    watch.execute();
    save(t, 'new1', { name: 'Meowth EX', number: '62/88', binderId: 'b', page: 1, slot: 1 });
    save(t, 'new2', { name: 'Nidorina', number: '101' });
    update(t, 'old', { notes: 'edited' }); // an existing card being edited isn't new
    await watch.idle();
    assert.deepEqual(t.pricing.priced, ['new1', 'new2']);
    matches(cardOf(t.ledger, 'new1'), { set: 'Perfect Order', setCode: 'POR', rarity: 'Double Rare', artist: '5ban Graphics' });
    matches(cardOf(t.ledger, 'new2'), { details: { result: 'notFound' } });
    assert.equal(cardOf(t.ledger, 'old')['details'], undefined);
    assert.deepEqual(t.logged.info, [
      'Filled in Meowth EX 62/88: set, setCode, rarity, artist, released from TCGdex',
      'New card Meowth EX 62/88: price and picture found',
      'New card Nidorina 101: price and picture found',
    ]);
    // A pause before the first card (the request that added it finishes first), then between cards.
    assert.deepEqual(t.scheduler.pauses, [200, 1]);
    watch.stop();
  });

  it('fills in a card that a CSV row replaced (same id, different name and number)', async () => {
    const t = setUp();
    // Matched once (to another card, standing in for Bill), with that card's release date.
    const match = { source: 'tcgdex', result: 'complete', id: 'base1-87', released: '1999-01-09', checkedAt: t.clock.at.toISOString() };
    t.ledger.seed('cards', 'pocket', { name: 'Bill', number: '118/130', set: 'Base Set', setCode: 'PBS', binderId: 'b', page: 1, slot: 1, released: '1999-01-09', details: match });
    const { watch } = autofill(t);
    watch.execute();
    // What the CSV import writes: the whole card, under the pocket's card id (here keeping the old match, as an edit in the drawer would).
    save(t, 'pocket', { name: 'Charizard V', number: '17/172', binderId: 'b', page: 1, slot: 1, details: match });
    await watch.idle();
    assert.deepEqual(t.pricing.priced, ['pocket']);
    matches(cardOf(t.ledger, 'pocket'), { set: 'Brilliant Stars', setCode: 'BRS', rarity: 'Ultra Rare', artist: 'N-DESIGN Inc.', released: '2022-02-25', details: { id: 'swsh9-017' } });
    assert.deepEqual(t.logged.info.slice(-1), ['Changed card Charizard V 17/172: price and picture found']);
  });

  it("redoes an automatic match when a card's name or number is edited, and keeps one the person chose", async () => {
    const t = setUp();
    const recent = t.clock.at.toISOString();
    t.ledger.seed('cards', 'auto', { name: 'Pikachu', number: '51', setCode: 'XYZ', pricing: { source: 'pricecharting', id: '/old', linkedBy: 'auto' }, officialImageId: 'old', details: { source: 'tcgdex', result: 'several', checkedAt: recent } });
    t.ledger.seed('cards', 'mine', { name: 'Pikachu', number: '51', pricing: { source: 'tcgplayer', id: '9', linkedBy: 'user' }, officialImageId: 'img' });
    // The other site's automatic match was for the old card too; one the person chose stays.
    t.ledger.seed('cards', 'pairAuto', { name: 'Pikachu', number: '51', pricing: { source: 'pricecharting', id: '/mine', linkedBy: 'user', pair: { source: 'tcgplayer', id: '9', linkedBy: 'auto' } } });
    t.ledger.seed('cards', 'pairMine', { name: 'Pikachu', number: '51', pricing: { source: 'pricecharting', id: '/mine', linkedBy: 'user', pair: { source: 'tcgplayer', id: '9', linkedBy: 'user' } } });
    const seen: Record<string, unknown> = {};
    t.pricing.onPrice = (id) => {
      seen[id] = cardOf(t.ledger, id)['pricing'] ?? null;
    };
    const { watch } = autofill(t);
    watch.execute();
    update(t, 'auto', { number: '51/162' });
    update(t, 'mine', { number: '51/162' });
    update(t, 'mine', { notes: 'only the notes changed' });
    update(t, 'pairAuto', { number: '51/162' });
    update(t, 'pairMine', { number: '51/162' });
    await watch.idle();
    assert.deepEqual(seen, {
      auto: null,
      mine: { source: 'tcgplayer', id: '9', linkedBy: 'user' },
      pairAuto: { source: 'pricecharting', id: '/mine', linkedBy: 'user', pair: null },
      pairMine: { source: 'pricecharting', id: '/mine', linkedBy: 'user', pair: { source: 'tcgplayer', id: '9', linkedBy: 'user' } },
    });
    // Looked up again despite this week's lookup, because it's a different card now.
    matches(cardOf(t.ledger, 'auto'), { set: 'Temporal Forces', artist: 'kodama', setCode: 'XYZ', officialImageId: null, details: { result: 'filled' } });
    assert.equal(cardOf(t.ledger, 'mine')['officialImageId'], 'img');
    assert.equal(t.pricing.priced.length, 4);
  });

  it('fills details only when automatic prices are off, and leaves pricing to a daily run in progress', async () => {
    for (const off of [{ enabled: false }, { running: true }]) {
      const t = setUp();
      Object.assign(t.pricing, off);
      const { watch } = autofill(t);
      watch.execute();
      save(t, 'c', { name: 'Pikachu', number: '51/162' });
      await watch.idle();
      assert.deepEqual(t.pricing.priced, []);
      matches(cardOf(t.ledger, 'c'), { setCode: 'TEF' });
      watch.stop();
    }
  });

  it("doesn't treat a restored ledger as new cards", async () => {
    const t = setUp();
    const { watch } = autofill(t);
    watch.execute();
    t.ledger.seed('cards', 'r1', { name: 'Pikachu', number: '51/162' });
    t.changes.emit({ kind: 'replaced' });
    update(t, 'r1', { notes: 'x' });
    await watch.idle();
    assert.deepEqual(t.pricing.priced, []);
  });

  it('logs a card that failed and carries on with the next', async () => {
    const t = setUp();
    t.pricing.onPrice = (id) => {
      if (id === 'a') throw new Error('the price sites fell over');
    };
    const { watch } = autofill(t);
    watch.execute();
    save(t, 'a', { name: 'Pikachu', number: '51/162' });
    save(t, 'b', { name: 'Nidorina', number: '101' });
    await watch.idle();
    assert.deepEqual(t.logged.warn, ['Filling in a new card failed: the price sites fell over']);
    assert.deepEqual(t.pricing.priced, ['a', 'b']);
  });

  it('stops cleanly: no more cards are taken up, and the backfill waiting is cancelled', async () => {
    const t = setUp();
    const { watch } = autofill(t, 60_000);
    watch.execute();
    assert.deepEqual(t.scheduler.waiting, [60_000]);
    assert.equal(t.changes.listening, 1);
    watch.stop();
    assert.deepEqual(t.scheduler.waiting, []);
    assert.equal(t.changes.listening, 0);
    save(t, 'a', { name: 'Pikachu', number: '51/162' });
    await watch.idle();
    assert.deepEqual(t.pricing.priced, []);
  });
});

describe('looking cards up again after an update', () => {
  it('runs by itself after starting, only when cards still need it', async () => {
    const t = setUp();
    const done = { set: 'Base Set', setCode: 'BS', rarity: 'Uncommon', artist: 'Keiji Kinebuchi' };
    t.ledger.seed('cards', 'a', { name: 'Pokedex', number: '87/102', ...done, details: { source: 'tcgdex', result: 'complete', id: 'base1-87', checkedAt: t.clock.at.toISOString() } });
    // Typed in full before details were filled in, so never looked up.
    t.ledger.seed('cards', 'b', { name: 'Charizard V', number: '17/172', set: 'Brilliant Stars', setCode: 'BRS', rarity: 'Ultra Rare', artist: 'N-DESIGN Inc.' });
    // Looked up this week without a match: left to the weekly retry.
    t.ledger.seed('cards', 'c', { name: 'Pikachu', number: '51', details: { source: 'tcgdex', result: 'several', v: DETAILS_VERSION, checkedAt: t.clock.at.toISOString() } });
    const { watch, fillEvery, backfill } = autofill(t, 1);
    watch.execute();
    t.scheduler.runAll();
    await settle();
    await fillEvery.finished();
    matches(cardOf(t.ledger, 'a'), { released: '1999-01-09' });
    matches(cardOf(t.ledger, 'b'), { released: '2022-02-25' });
    matches(t.ledger.tables.settings.get('details'), { running: false, done: 2, total: 2, lastRun: { cards: 2, filled: 2 } });
    assert.ok(t.logged.info.includes('2 cards to look up or check again after an update'));
    assert.equal(await backfill.execute(), 0);
  });
});

describe('Fill in missing details', () => {
  it('looks up every card with blanks, with its progress in settings/details', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51/162' });
    t.ledger.seed('cards', 'b', { name: 'Pikachu', number: '51' });
    // Everything but its release date.
    t.ledger.seed('cards', 'c', { name: 'Charizard V', number: '17/172', set: 'Brilliant Stars', setCode: 'BRS', rarity: 'Ultra Rare', artist: 'N-DESIGN Inc.' });
    const { fillEvery } = autofill(t);
    assert.deepEqual(await fillEvery.execute({ actor: 'justin' }), { started: true, cards: 3 });
    // Started again while it runs: the same run.
    assert.deepEqual(await fillEvery.execute({ actor: 'megan' }), { started: false, cards: 3 });
    await fillEvery.finished();
    matches(t.ledger.tables.settings.get('details'), { running: false, done: 3, total: 3, lastRun: { cards: 3, filled: 2, several: 1, notFound: 0, error: 0, skipped: 0 } });
    matches(cardOf(t.ledger, 'a'), { artist: 'kodama', released: '2024-03-22' });
    matches(cardOf(t.ledger, 'c'), { released: '2022-02-25', details: { filled: ['released'] } });
    assert.deepEqual(t.logged.info, ['justin started Fill in missing details (3 cards)', 'Filling in missing details for 3 cards', 'Filled in missing details: 2 cards filled, 1 with several matches, 0 not found, 0 failed']);
    // b was looked up this week: only asked about again when told to.
    assert.deepEqual(await fillEvery.execute(), { started: true, cards: 0 });
    await fillEvery.finished();
    assert.deepEqual(await fillEvery.execute({ force: true }), { started: true, cards: 1 });
    await fillEvery.finished();
  });

  it('stops after the card it is on when the server stops, saving how far it got', async () => {
    const t = setUp();
    for (const id of ['a', 'b', 'c']) t.ledger.seed('cards', id, { name: 'Pikachu', number: '51/162' });
    const { fillEvery } = autofill(t);
    await fillEvery.execute();
    fillEvery.stop();
    await fillEvery.finished();
    matches(t.ledger.tables.settings.get('details'), { running: false, total: 3, lastRun: { cards: 3 } });
    assert.ok(Number(t.ledger.tables.settings.get('details')?.['done']) < 3);
    assert.equal(fillEvery.running, false);
  });
});
