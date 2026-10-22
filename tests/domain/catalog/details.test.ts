import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Card, type CardId } from '#domain/cards/card.ts';
import { DETAILS_VERSION } from '#domain/cards/attention.ts';
import {
  cardIdentity,
  cardLabel,
  cardQuery,
  closeNames,
  type DetailsMatch,
  filing,
  filingLabel,
  formerCardForgotten,
  lookupRecord,
  narrowByHints,
  narrowToFamily,
  outdated,
  patchFor,
  sameCards,
  suggestions,
  wantsDetails,
} from '#domain/catalog/details.ts';
import { AT, value } from '../fixtures.ts';

const match = (over: Partial<DetailsMatch> = {}): DetailsMatch => ({
  id: 'sv05-051',
  setId: 'sv05',
  name: 'Pikachu',
  number: '051',
  set: 'Temporal Forces',
  setCode: 'TEF',
  total: 162,
  rarity: 'Common',
  artist: 'kodama',
  released: '2024-03-22',
  thumb: null,
  ...over,
});
const celebration = match({ id: '30th-051', setId: '30th', set: '30th Celebration', setCode: '30C', total: 128, released: '2026-02-27' });

describe('finding the card in the card database', () => {
  it('searches by a word of its name and its own number, and keeps only that card', () => {
    const q = cardQuery("N's Zekrom", '031');
    assert.ok(q);
    assert.deepEqual([q.word, q.own], ['Zekrom', '31']);
    const found = sameCards(
      [
        { id: 'mep-031', localId: '031', name: "N's Zekrom" },
        { id: 'sv09-031', localId: '031', name: 'Zekrom' },
        { id: 'A1-031', localId: '031', name: "N's Zekrom" },
      ],
      q,
      new Set(),
    );
    assert.deepEqual(found.map((c) => c.id), ['mep-031']);
    assert.equal(cardQuery('', '51'), null);
    assert.equal(cardQuery('Pikachu', ' '), null);
  });

  it('narrows by the set size, set code and set typed, but never to nothing', () => {
    const both = [match(), celebration];
    assert.deepEqual(narrowByHints(both, '51/162', {}).map((m) => m.id), ['sv05-051']);
    assert.deepEqual(narrowByHints(both, '51', { setCode: 'tef' }).map((m) => m.id), ['sv05-051']);
    assert.deepEqual(narrowByHints(both, '51', { set: 'Pokemon 30th Celebration' }).map((m) => m.id), ['30th-051']);
    assert.deepEqual(narrowByHints(both, '51', { setCode: 'XYZ' }).length, 2);
  });

  it("keeps the matches in the set it's filed under, or says there are none there", () => {
    const aquapolis = match({ id: 'ecard2-149', setId: 'ecard2' });
    const reprint = match({ id: '30th-c-029', setId: '30th-c' });
    assert.deepEqual(narrowToFamily([aquapolis, reprint], '30th'), { matches: [reprint], none: false });
    assert.deepEqual(narrowToFamily([aquapolis], '30th'), { matches: [aquapolis], none: true });
  });

  it('suggests close names that agree with what was typed about the set', () => {
    const list = [
      { id: 'me02.5-061', localId: '061', name: 'Mega Eelektross ex' },
      { id: 'x-061', localId: '061', name: 'Pikachu' },
      { id: 'y-062', localId: '062', name: 'Mega Eelektross ex' },
    ];
    assert.deepEqual(closeNames(list, 'Mega Eelktross EX', '61').map((c) => c.id), ['me02.5-061']);
    const eel = match({ id: 'me02.5-061', name: 'Mega Eelektross ex', set: 'Ascended Heroes', setCode: 'ASC', number: '061', total: 217 });
    assert.deepEqual(suggestions([eel], '61/217', {}).map((o) => o.id), ['me02.5-061']);
    assert.deepEqual(suggestions([eel], '61/99', { setCode: 'XYZ' }), []);
    // Nothing typed about the set: any close name.
    assert.deepEqual(suggestions([eel], '61', {}).map((o) => o.id), ['me02.5-061']);
  });
});

describe("the set a card is filed under", () => {
  const named = (id: string, name: string, released: string | null = null) => ({ id, name, released });

  it('needs no lookup when it is the match’s own set, or none', () => {
    assert.equal(filingLabel(match(), 'Temporal Forces'), null);
    assert.equal(filingLabel(match(), ''), null);
    assert.equal(filingLabel(match(), 'Pokemon Crown Zenith'), 'Crown Zenith');
  });

  it("is fine when TCGdex doesn't know the label, or it's the match's set", () => {
    assert.deepEqual(filing(match(), 'My own label', null), { released: '2024-03-22', filedUnder: null });
    assert.deepEqual(filing(match(), 'TF', named('sv05', 'Temporal Forces')), { released: '2024-03-22', filedUnder: null });
  });

  it('takes the date of the set a reprint sub-set belongs to, and names it', () => {
    assert.deepEqual(filing(match({ setId: '30th-c', released: null }), '30th Celebration', named('30th', '30th Celebration', '2026-02-27')), { released: '2026-02-27', filedUnder: null, parentSet: '30th Celebration' });
  });

  it("dates a promo by the set it's filed under", () => {
    const promo = match({ setId: 'swshp', set: 'SWSH Black Star Promos', released: '2019-11-15' });
    assert.deepEqual(filing(promo, 'Pokemon Crown Zenith', named('swsh12.5', 'Crown Zenith', '2023-01-20')), { released: '2023-01-20', filedUnder: null });
  });

  it('flags a card filed under a set its name and number are not from', () => {
    const bill = match({ id: 'base4-118', setId: 'base4', set: 'Base Set 2', released: '2000-02-24' });
    assert.deepEqual(filing(bill, 'Pokemon Base Set', named('base1', 'Base Set')), { released: '2000-02-24', filedUnder: { as: 'Pokemon Base Set', id: 'base1', name: 'Base Set' } });
  });
});

describe('which cards want a lookup', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const pikachu = { name: 'Pikachu', number: '51/162' };

  it('leaves alone cards that are complete, not English, or missing a name or number', () => {
    assert.equal(wantsDetails({ ...pikachu, set: 'x', setCode: 'x', rarity: 'x', artist: 'x', released: '2024-03-22' }, now), false);
    assert.equal(wantsDetails({ ...pikachu, language: 'Japanese' }, now), false);
    assert.equal(wantsDetails({ ...pikachu, language: 'English' }, now), true);
    assert.equal(wantsDetails({ number: '51/162' }, now), false);
    assert.equal(wantsDetails(undefined, now), false);
  });

  it('asks again after a week, or when told to', () => {
    const recent = { ...pikachu, details: { source: 'tcgdex', result: 'several', v: DETAILS_VERSION, checkedAt: '2026-10-01T00:00:00Z' } };
    assert.equal(wantsDetails(recent, now), false);
    assert.equal(wantsDetails(recent, now, true), true);
    assert.equal(wantsDetails({ ...pikachu, details: { ...recent.details, checkedAt: '2026-09-20T00:00:00Z' } }, now), true);
  });

  it('redoes a lookup made before the current checks straight away, complete or not', () => {
    const complete = { ...pikachu, set: 'x', setCode: 'x', rarity: 'x', artist: 'x', released: 'x' };
    const before = { ...complete, details: { source: 'tcgdex', result: 'complete', id: 'sv05-051', checkedAt: '2026-10-02T00:00:00Z' } };
    assert.equal(outdated(before), true);
    assert.equal(wantsDetails(before, now), true);
    assert.equal(outdated({ ...complete, details: { ...before.details, v: DETAILS_VERSION } }), false);
    // A failed lookup from before isn't redone for that.
    assert.equal(outdated({ ...complete, details: { source: 'tcgdex', result: 'error', checkedAt: '2026-10-02T00:00:00Z' } }), false);
  });
});

describe('what a lookup records on the card', () => {
  const at = '2026-10-03T12:00:00.000Z';

  it('fills only the blanks from a single match', () => {
    assert.deepEqual(patchFor({ rarity: 'Mine', set: ' ' }, match({ artist: null })), { patch: { set: 'Temporal Forces', setCode: 'TEF', released: '2024-03-22' }, filled: ['set', 'setCode', 'released'] });
    const r = lookupRecord({ name: 'Pikachu', rarity: 'Mine' }, { kind: 'one', match: match(), filing: { released: '2024-03-22', filedUnder: null }, chosen: true }, at);
    assert.equal(r.result, 'filled');
    assert.deepEqual(r.patch, {
      set: 'Temporal Forces',
      setCode: 'TEF',
      artist: 'kodama',
      released: '2024-03-22',
      details: { source: 'tcgdex', v: DETAILS_VERSION, checkedAt: at, result: 'filled', id: 'sv05-051', filled: ['set', 'setCode', 'artist', 'released'], setId: 'sv05', set: 'Temporal Forces', setCode: 'TEF', released: '2024-03-22', filedUnder: null, chosen: true },
    });
    const complete = lookupRecord({ set: 'a', setCode: 'b', rarity: 'c', artist: 'd', released: 'e' }, { kind: 'one', match: match(), filing: { released: null, filedUnder: null, parentSet: 'X' }, chosen: false }, at);
    assert.equal(complete.result, 'complete');
    assert.deepEqual(complete.patch['details'], { source: 'tcgdex', v: DETAILS_VERSION, checkedAt: at, result: 'complete', id: 'sv05-051', filled: [], setId: 'sv05', set: 'Temporal Forces', setCode: 'TEF', released: null, filedUnder: null, parentSet: 'X' });
  });

  it('keeps the choices, or the names it may be', () => {
    assert.deepEqual(lookupRecord({}, { kind: 'several', options: [match(), celebration] }, at), {
      patch: { details: { source: 'tcgdex', v: DETAILS_VERSION, checkedAt: at, result: 'several', options: [match(), celebration].map(({ setId: _s, rarity: _r, artist: _a, released: _d, ...o }) => o) } },
      result: 'several',
    });
    assert.deepEqual(lookupRecord({}, { kind: 'none', suggest: [] }, at).patch, { details: { source: 'tcgdex', v: DETAILS_VERSION, checkedAt: at, result: 'notFound', suggest: null } });
  });

  it('keeps the match it had when the card database fails, unless it no longer has that card', () => {
    const had = { details: { source: 'tcgdex', result: 'filled', v: DETAILS_VERSION, id: 'sv05-051', setId: 'sv05', set: 'Temporal Forces', setCode: 'TEF', released: null, chosen: true, options: [], checkedAt: '2026-10-01T00:00:00Z' } };
    assert.deepEqual(lookupRecord(had, { kind: 'failed', message: 'down', gone: false }, at).patch, {
      details: { v: DETAILS_VERSION, id: 'sv05-051', setId: 'sv05', set: 'Temporal Forces', setCode: 'TEF', chosen: true, source: 'tcgdex', result: 'error', error: 'down', checkedAt: at },
    });
    assert.deepEqual(lookupRecord(had, { kind: 'failed', message: '404', gone: true }, at).patch, { details: { source: 'tcgdex', result: 'error', error: '404', checkedAt: at } });
  });

  it("is saved on the card, which tells open pages it changed", () => {
    const card = Card.reconstitute({ id: 'c1' as CardId, fields: { name: 'Pikachu', number: '51/162' } });
    assert.equal(value(card.recordLookup({ kind: 'one', match: match(), filing: { released: '2024-03-22', filedUnder: null }, chosen: false }, AT)), 'filled');
    assert.equal(card.fields['setCode'], 'TEF');
    assert.deepEqual(card.pullEvents().map((e) => e.type), ['DocumentSaved']);
  });
});

describe('a card that became a different one', () => {
  it('forgets its match and release date, and an automatic price match', () => {
    assert.deepEqual(formerCardForgotten({ pricing: { source: 'pricecharting', id: '/old', linkedBy: 'auto' } }), { details: null, released: null, pricing: null, officialImageId: null });
    assert.deepEqual(formerCardForgotten({ pricing: { source: 'tcgplayer', id: '9', linkedBy: 'user' } }), { details: null, released: null });
    assert.deepEqual(formerCardForgotten({ pricing: { source: 'pricecharting', linkedBy: 'user', pair: { source: 'tcgplayer', linkedBy: 'auto' } } }), { details: null, released: null, pricing: { source: 'pricecharting', linkedBy: 'user', pair: null } });
    assert.deepEqual(formerCardForgotten({ pricing: { source: 'pricecharting', linkedBy: 'user', pair: { source: 'tcgplayer', linkedBy: 'auto', off: true } } }), { details: null, released: null });
    assert.deepEqual(formerCardForgotten({}), { details: null, released: null });
    const card = Card.reconstitute({ id: 'c1' as CardId, fields: { name: 'Bill', released: '1999-01-09', details: { source: 'tcgdex', result: 'complete', checkedAt: AT.toISOString() } } });
    value(card.forgetFormerCard(AT));
    assert.deepEqual([card.fields['details'], card.fields['released']], [null, null]);
  });

  it('is told by its name and number, however they are spaced or capitalised', () => {
    assert.equal(cardIdentity({ name: ' Pikachu ', number: '51 / 162' }), cardIdentity({ name: 'pikachu', number: '51/162' }));
    assert.notEqual(cardIdentity({ name: 'Pikachu', number: '51' }), cardIdentity({ name: 'Pikachu', number: '51/162' }));
    assert.equal(cardLabel({ name: 'Pikachu', set: 'Temporal Forces', number: '51/162' }), 'Pikachu Temporal Forces 51/162');
    assert.equal(cardLabel({ setCode: 'TEF' }), 'Unnamed card TEF');
  });
});
