import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChooseMatch } from '#application/catalog/choose-match.ts';
import { FillCardDetails } from '#application/catalog/fill-card-details.ts';
import { DETAILS_VERSION } from '#domain/cards/attention.ts';
import { cardOf, matches, setUp } from './fixtures.ts';

/** Fill in a stored card (`force`: even if it was looked up this week; `chosen`: the person chose this TCGdex card). */
const filler = (t: ReturnType<typeof setUp>) => {
  const fill = new FillCardDetails(t.deps);
  return (cardId: string, force = false, chosen?: string) => fill.execute({ cardId, force, chosen });
};

describe('filling in a stored card', () => {
  it('fills only the empty fields and records what it did', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51/162', rarity: 'My own rarity' });
    assert.equal(await filler(t)('a'), 'filled');
    matches(cardOf(t.ledger, 'a'), {
      set: 'Temporal Forces',
      setCode: 'TEF',
      rarity: 'My own rarity',
      artist: 'kodama',
      released: '2024-03-22',
      details: { source: 'tcgdex', result: 'filled', id: 'sv05-051', filled: ['set', 'setCode', 'artist', 'released'], released: '2024-03-22', checkedAt: t.clock.at.toISOString() },
    });
    assert.deepEqual(t.published.map((e) => [e.type, e.id]), [['DocumentSaved', 'a']]);
  });

  it('changes nothing when several cards match or none does, and notes why', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51' });
    t.ledger.seed('cards', 'b', { name: 'Nidorina', number: '101', setCode: 'MEP' });
    const fill = filler(t);
    assert.equal(await fill('a'), 'several');
    assert.equal(await fill('b'), 'notFound');
    matches(cardOf(t.ledger, 'a'), { name: 'Pikachu', number: '51', details: { result: 'several' } });
    assert.equal(cardOf(t.ledger, 'a')['set'], undefined);
    matches(cardOf(t.ledger, 'b'), { setCode: 'MEP', details: { result: 'notFound', suggest: null } });
  });

  it('leaves alone cards that are complete, not English, missing a name or number, gone, or looked up this week', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'full', { name: 'Pikachu', number: '51/162', set: 'x', setCode: 'x', rarity: 'x', artist: 'x', released: '2024-03-22' });
    t.ledger.seed('cards', 'ja', { name: 'Pikachu', number: '51/162', language: 'Japanese' });
    t.ledger.seed('cards', 'noname', { number: '51/162' });
    t.ledger.seed('cards', 'recent', { name: 'Pikachu', number: '51', details: { source: 'tcgdex', result: 'several', v: DETAILS_VERSION, checkedAt: '2026-10-01T00:00:00Z' } });
    t.ledger.seed('cards', 'old', { name: 'Pikachu', number: '51/162', details: { source: 'tcgdex', result: 'notFound', checkedAt: '2026-09-20T00:00:00Z' } });
    const fill = filler(t);
    for (const id of ['full', 'ja', 'noname', 'recent', 'gone']) assert.equal(await fill(id), 'skipped', id);
    assert.equal(await fill('recent', true), 'several');
    assert.equal(await fill('old'), 'filled');
  });

  it('redoes a lookup from before the current checks, by its TCGdex id when it was made with them', async () => {
    const t = setUp();
    const done = { set: 'Base Set', setCode: 'BS', rarity: 'Uncommon', artist: 'Keiji Kinebuchi' };
    // Looked up yesterday, before release dates.
    t.ledger.seed('cards', 'a', { name: 'Pokedex', number: '87/102', ...done, details: { source: 'tcgdex', result: 'filled', id: 'base1-87', checkedAt: '2026-10-02T00:00:00Z' } });
    // Complete, with its date, but checked before the set it's filed under was checked.
    t.ledger.seed('cards', 'd', { name: 'Pokedex', number: '87/102', ...done, released: '1999-01-09', details: { source: 'tcgdex', result: 'complete', id: 'base1-87', released: '1999-01-09', checkedAt: '2026-10-02T00:00:00Z' } });
    const fill = filler(t);
    assert.equal(await fill('d'), 'complete');
    matches(cardOf(t.ledger, 'd')['details'], { v: DETAILS_VERSION, setId: 'base1', set: 'Base Set', setCode: 'BS', filedUnder: null });
    assert.equal(await fill('a'), 'filled');
    matches(cardOf(t.ledger, 'a'), { ...done, released: '1999-01-09', details: { result: 'filled', id: 'base1-87', filled: ['released'], released: '1999-01-09' } });
    // An automatic match from before the current checks is looked up again (it could be from another set).
    assert.ok(t.database.asked.some((p) => p.startsWith('/cards?')));
    // One made with the current checks is fetched by its id.
    t.ledger.seed('cards', 'e', { name: 'Pokedex', number: '87/102', set: 'Base Set', details: { source: 'tcgdex', result: 'complete', v: DETAILS_VERSION, id: 'base1-87', checkedAt: '2026-10-02T00:00:00Z' } });
    t.database.asked.length = 0;
    assert.equal(await fill('e', true), 'filled');
    assert.ok(!t.database.asked.some((p) => p.startsWith('/cards?')));
  });

  it('finds a reprint in its set’s Classic Collection, not the card it reprints from another set', async () => {
    const t = setUp();
    // The 30th Celebration Lugia reprints the Aquapolis one and keeps its printed number, 149/147.
    t.ledger.seed('cards', 'mine', { name: 'Lugia', number: '149/147', set: '30th Celebration' });
    t.ledger.seed('cards', 'byTcgdex', { name: 'Lugia', number: '029', set: '30th Celebration' });
    t.ledger.seed('cards', 'aquapolis', { name: 'Lugia', number: '149/147', set: 'Aquapolis' });
    t.ledger.seed('cards', 'bare', { name: 'Lugia', number: '149/147' });
    const fill = filler(t);
    for (const id of ['mine', 'byTcgdex', 'aquapolis', 'bare']) assert.equal(await fill(id), 'filled', id);
    matches(cardOf(t.ledger, 'mine'), { set: '30th Celebration', details: { id: '30th-c-029', setId: '30th-c', set: '30th Classic Collection', parentSet: '30th Celebration', filedUnder: null } });
    matches(cardOf(t.ledger, 'byTcgdex')['details'], { id: '30th-c-029' });
    matches(cardOf(t.ledger, 'aquapolis')['details'], { id: 'ecard2-149', filedUnder: null });
    matches(cardOf(t.ledger, 'bare')['details'], { id: 'ecard2-149' });
  });

  it('looks an older automatic match up again, replacing one from another set, but keeps what the person chose', async () => {
    const t = setUp();
    const old = { source: 'tcgdex', result: 'filled', v: 2, id: 'ecard2-149', setId: 'ecard2', set: 'Aquapolis', checkedAt: '2026-10-01T00:00:00Z' };
    t.ledger.seed('cards', 'auto', { name: 'Lugia', number: '149/147', set: '30th Celebration', details: old });
    t.ledger.seed('cards', 'chose', { name: 'Lugia', number: '149/147', set: '30th Celebration', details: { ...old, chosen: true } });
    const fill = filler(t);
    await fill('auto');
    await fill('chose');
    matches(cardOf(t.ledger, 'auto')['details'], { v: DETAILS_VERSION, id: '30th-c-029' });
    assert.ok(!('chosen' in (cardOf(t.ledger, 'auto')['details'] as object)));
    matches(cardOf(t.ledger, 'chose')['details'], { v: DETAILS_VERSION, id: 'ecard2-149', chosen: true });
    // Choosing from Cards to check is remembered.
    await fill('auto', true, 'ecard2-149');
    matches(cardOf(t.ledger, 'auto')['details'], { id: 'ecard2-149', chosen: true });
  });

  it("dates a promo by the set it's filed under, when TCGdex knows that set", async () => {
    const t = setUp();
    t.ledger.seed('cards', 'filed', { name: 'Hisuian Zoroark V Star', number: 'SWSH298', set: 'Pokemon Crown Zenith' });
    t.ledger.seed('cards', 'bare', { name: 'Hisuian Zoroark V Star', number: 'SWSH298' });
    t.ledger.seed('cards', 'odd', { name: 'Hisuian Zoroark V Star', number: 'SWSH298', set: 'My promos' });
    const fill = filler(t);
    for (const id of ['filed', 'bare', 'odd']) assert.equal(await fill(id), 'filled');
    matches(cardOf(t.ledger, 'filed'), { set: 'Pokemon Crown Zenith', released: '2023-01-20', details: { released: '2023-01-20' } });
    // Not filed anywhere, or under a set TCGdex doesn't have: the promo series' date.
    matches(cardOf(t.ledger, 'bare'), { set: 'SWSH Black Star Promos', released: '2019-11-15' });
    assert.equal(cardOf(t.ledger, 'odd')['released'], '2019-11-15');
  });

  it('flags a card filed under a set that TCGdex knows but that its name and number are not from', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'wrong', { name: 'Bill', number: '118/130', set: 'Pokemon Base Set', setCode: 'PBS' });
    t.ledger.seed('cards', 'right', { name: 'Bill', number: '118/130', set: 'Base Set 2', setCode: 'PBS' });
    t.ledger.seed('cards', 'ownLabel', { name: 'Bill', number: '118/130', set: 'Pokemon Base Set Two', setCode: 'PBS' });
    const fill = filler(t);
    for (const id of ['wrong', 'right', 'ownLabel']) await fill(id);
    matches(cardOf(t.ledger, 'wrong'), {
      set: 'Pokemon Base Set', // never changed by itself
      released: '2000-02-24',
      details: { result: 'filled', id: 'base4-118', setId: 'base4', set: 'Base Set 2', setCode: 'B2', filedUnder: { as: 'Pokemon Base Set', id: 'base1', name: 'Base Set' } },
    });
    matches(cardOf(t.ledger, 'right')['details'], { filedUnder: null });
    matches(cardOf(t.ledger, 'ownLabel')['details'], { filedUnder: null });
  });

  it('suggests the name a card not found probably has, when it agrees with the set typed', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'eel', { name: 'Mega Eelktross EX', number: '61/217', set: 'Ascended Heroes', setCode: 'ASC' });
    t.ledger.seed('cards', 'elsewhere', { name: 'Mega Eelktross EX', number: '61/99', setCode: 'XYZ' });
    const fill = filler(t);
    assert.equal(await fill('eel'), 'notFound');
    matches(cardOf(t.ledger, 'eel')['details'], {
      result: 'notFound',
      v: DETAILS_VERSION,
      suggest: [{ id: 'me02.5-061', name: 'Mega Eelektross ex', set: 'Ascended Heroes', setCode: 'ASC', number: '061', total: 217 }],
    });
    assert.equal(await fill('elsewhere'), 'notFound');
    matches(cardOf(t.ledger, 'elsewhere')['details'], { suggest: null });
  });

  it('keeps the choices when several cards match, and uses the one chosen', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51', rarity: 'Mine' });
    const fill = filler(t);
    assert.equal(await fill('a'), 'several');
    const options = (cardOf(t.ledger, 'a')['details'] as { options: { setCode: string }[] }).options;
    assert.deepEqual(options.map((o) => o.setCode).sort(), ['30C', 'TEF']);
    assert.equal(await fill('a', true, 'sv05-051'), 'filled');
    matches(cardOf(t.ledger, 'a'), { set: 'Temporal Forces', setCode: 'TEF', rarity: 'Mine', released: '2024-03-22', details: { result: 'filled', id: 'sv05-051', chosen: true } });
  });

  it('keeps the match the person chose when a lookup fails, and uses it next time', async () => {
    const t = setUp();
    // Pikachu 51 is in two sets; the person chose Temporal Forces'. Its rarity is still blank.
    const chosen = { source: 'tcgdex', result: 'filled', v: DETAILS_VERSION, id: 'sv05-051', setId: 'sv05', set: 'Temporal Forces', setCode: 'TEF', chosen: true, checkedAt: '2026-10-01T00:00:00Z' };
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51', details: chosen });
    t.database.down = true;
    assert.equal(await filler(t)('a', true), 'error');
    const { checkedAt: _, result: __, ...match } = chosen;
    assert.deepEqual(cardOf(t.ledger, 'a')['details'], { ...match, result: 'error', error: "Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND api.tcgdex.net", checkedAt: t.clock.at.toISOString() });
    // TCGdex is back: the chosen card is fetched by its id, not offered as one of several again.
    t.database.down = false;
    assert.notEqual(await filler(t)('a', true), 'several');
    matches(cardOf(t.ledger, 'a')['details'], { id: 'sv05-051', chosen: true });
    assert.ok(t.database.asked.includes('/cards/sv05-051'));
  });

  it('searches again when TCGdex no longer has the matched card', async () => {
    const t = setUp();
    const gone = { source: 'tcgdex', result: 'filled', v: DETAILS_VERSION, id: 'sv05-999', setId: 'sv05', set: 'Temporal Forces', chosen: true, checkedAt: '2026-10-01T00:00:00Z' };
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51', details: gone });
    const fill = filler(t);
    assert.equal(await fill('a', true), 'error');
    const details = cardOf(t.ledger, 'a')['details'];
    matches(details, { result: 'error', error: 'api.tcgdex.net answered 404' });
    assert.ok(!('id' in (details as object)) && !('chosen' in (details as object)));
    assert.equal(await fill('a', true), 'several');
  });

  it('records a failed lookup without changing the card', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51/162' });
    t.database.down = true;
    assert.equal(await filler(t)('a'), 'error');
    matches(cardOf(t.ledger, 'a'), { name: 'Pikachu', details: { result: 'error' } });
    assert.equal(cardOf(t.ledger, 'a')['set'], undefined);
  });
});

describe('choosing a card from several matches', () => {
  const choose = (t: ReturnType<typeof setUp>) => new ChooseMatch({ ...t.deps, fillCard: new FillCardDetails(t.deps) });

  it('fills the card from the card chosen, then prices it', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51', details: { source: 'tcgdex', result: 'several', v: DETAILS_VERSION, checkedAt: '2026-10-03T00:00:00Z' } });
    const r = await choose(t).execute({ cardId: 'a', matchId: '30th-051' });
    assert.ok(r.ok);
    assert.equal(r.value.result, 'filled');
    matches(r.value.card, { set: '30th Celebration', setCode: '30C', details: { id: '30th-051', chosen: true } });
    assert.deepEqual(t.pricing.priced, ['a']);
  });

  it("doesn't price it without automatic prices, or while the daily update runs", async () => {
    for (const off of [{ enabled: false }, { running: true }]) {
      const t = setUp();
      Object.assign(t.pricing, off);
      t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51' });
      assert.ok((await choose(t).execute({ cardId: 'a', matchId: 'sv05-051' })).ok);
      assert.deepEqual(t.pricing.priced, []);
    }
  });

  it('refuses a card that no longer exists, an id that is no TCGdex id, and a lookup that failed', async () => {
    const t = setUp();
    t.ledger.seed('cards', 'a', { name: 'Pikachu', number: '51' });
    assert.deepEqual(await choose(t).execute({ cardId: 'gone', matchId: '30th-051' }), { ok: false, error: { code: 'CARD_NOT_FOUND' } });
    assert.deepEqual(await choose(t).execute({ cardId: 'a', matchId: 'no such/id' }), { ok: false, error: { code: 'INVALID_MATCH' } });
    assert.deepEqual(await choose(t).execute({ cardId: 'a', matchId: 42 }), { ok: false, error: { code: 'INVALID_MATCH' } });
    t.database.down = true;
    assert.deepEqual(await choose(t).execute({ cardId: 'a', matchId: '30th-051' }), { ok: false, error: { code: 'LOOKUP_FAILED' } });
    assert.deepEqual(t.pricing.priced, []);
  });
});

