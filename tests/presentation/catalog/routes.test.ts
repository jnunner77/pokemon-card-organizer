import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Caller } from '#application/access.ts';
import { err, ok } from '#shared/result.ts';
import { type CatalogUseCases, catalogRoutes } from '#presentation/catalog/routes.ts';
import { json, serve } from '../fixtures.ts';

const DOWN = { code: 'CARD_DATABASE_UNAVAILABLE', message: "Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND" } as const;

/** Routes with use cases that record what they were asked; the caller comes from the X-Role header. */
async function setUp(over: Partial<CatalogUseCases> = {}, off = false) {
  const asked: unknown[] = [];
  const record = <T>(answer: T) => ({ execute: async (input?: unknown) => (asked.push(input), answer) });
  const catalog: CatalogUseCases = {
    lookUpCard: record(ok({ matches: [{ id: 'sv05-051' }] })),
    chooseMatch: record(ok({ result: 'filled', card: { name: 'Pikachu' } })),
    fillEveryCard: record({ started: true, cards: 3 }),
    searchAnyCard: record(ok({ hits: [], more: false })),
    showAnyCard: record(ok({ id: 'base1-4' })),
    showAnyCardDetails: record(ok({ id: 'base1-4' })),
    listMasterSetSets: record(ok({ sets: [] })),
    previewMasterSet: record(ok({ title: 'Celebrations' })),
    createMasterSet: record(ok({ binderId: 'b1', cards: 48, pages: 6 })),
    ...over,
  } as CatalogUseCases;
  const routes = catalogRoutes({
    identify: (req) => {
      const role = req.headers['x-role'];
      return role === 'viewer' || role === 'editor' || role === 'admin' ? ({ name: 'justin', role } satisfies Caller) : null;
    },
    catalog: off ? null : catalog,
  });
  return { base: await serve(routes.handle), asked, routes };
}

const as = (role: string, init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers);
  headers.set('X-Role', role);
  return { ...init, headers };
};
const answer = async (r: Response) => [r.status, await r.json()];

describe('card lookup routes', () => {
  it('check who is calling before reading anything: editors look cards up, viewers may look at any card', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/cards/lookup?name=Pikachu&number=51`)), [401, { error: 'Please sign in', code: 'signin' }]);
    assert.deepEqual(await answer(await fetch(`${base}/cards/lookup?name=Pikachu&number=51`, as('viewer'))), [403, { error: 'You have view-only access.', code: 'forbidden' }]);
    assert.equal((await fetch(`${base}/master-sets`, as('viewer', json({ set: 'x' })))).status, 403);
    assert.equal((await fetch(`${base}/cards/fill-details`, as('viewer', { method: 'POST' }))).status, 403);
    assert.deepEqual(asked, []);
    assert.equal((await fetch(`${base}/lookup/search?q=pikachu`, as('viewer'))).status, 200);
  });

  it('look a card up for the Add card form', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/cards/lookup?name=%20Pikachu%20&number=51&set=&setCode=TEF`, as('editor'))), [200, { matches: [{ id: 'sv05-051' }] }]);
    assert.deepEqual(asked, [{ name: 'Pikachu', number: '51', set: '', setCode: 'TEF' }]);
    for (const q of ['name=Pikachu', 'number=51', 'name=%20&number=51', 'name=a&name=b&number=1', `name=Pikachu&number=51&setCode=${'x'.repeat(41)}`])
      assert.deepEqual(await answer(await fetch(`${base}/cards/lookup?${q}`, as('editor'))), [400, { error: 'Give the card name and number.', code: 'invalid_argument' }], q);
  });

  it("answer 502 in the card database's words when it doesn't answer", async () => {
    const { base } = await setUp({ lookUpCard: { execute: async () => err(DOWN) }, searchAnyCard: { execute: async () => err(DOWN) }, showAnyCard: { execute: async () => err(DOWN) }, showAnyCardDetails: { execute: async () => err(DOWN) } });
    const failed = [502, { error: DOWN.message, code: 'upstream_error' }];
    assert.deepEqual(await answer(await fetch(`${base}/cards/lookup?name=Pikachu&number=51`, as('editor'))), failed);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/search?q=pikachu`, as('viewer'))), failed);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/base1-4`, as('viewer'))), failed);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/base1-4/details`, as('viewer'))), failed);
  });

  it('take the card a person chose, by its TCGdex id', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/cards/c1/details`, as('editor', json({ id: '30th-051' })))), [200, { result: 'filled', card: { name: 'Pikachu' } }]);
    assert.deepEqual(asked, [{ cardId: 'c1', matchId: '30th-051' }]);
    assert.deepEqual(await answer(await fetch(`${base}/cards/bad%20id/details`, as('editor', json({ id: '30th-051' })))), [404, { error: 'That card no longer exists.', code: 'not_found' }]);
    assert.deepEqual(await answer(await fetch(`${base}/cards/c1/details`, as('editor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' }))), [400, { error: "The request body isn't valid JSON", code: 'invalid_argument' }]);
  });

  it("map choosing a card's errors to statuses and words", async () => {
    const cases = [
      [{ code: 'CARD_NOT_FOUND' }, 404, { error: 'That card no longer exists.', code: 'not_found' }],
      [{ code: 'INVALID_MATCH' }, 400, { error: 'Give the TCGdex card id.', code: 'invalid_argument' }],
      [{ code: 'LOOKUP_FAILED' }, 502, { error: "The card database didn't answer. Try again.", code: 'upstream_error' }],
    ] as const;
    for (const [error, status, body] of cases) {
      const { base } = await setUp({ chooseMatch: { execute: async () => err(error) } });
      assert.deepEqual(await answer(await fetch(`${base}/cards/c1/details`, as('editor', json({ id: 'x' })))), [status, body]);
    }
  });

  it('start Fill in missing details, asked again even about cards looked up this week with force=1', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/cards/fill-details`, as('editor', { method: 'POST' }))), [202, { started: true, cards: 3 }]);
    await fetch(`${base}/cards/fill-details?force=1`, as('editor', { method: 'POST' }));
    await fetch(`${base}/cards/fill-details?force=1&force=1`, as('editor', { method: 'POST' }));
    assert.deepEqual(asked, [
      { actor: 'justin', force: false },
      { actor: 'justin', force: true },
      { actor: 'justin', force: false },
    ]);
  });

  it('search and show any card, and say when the card database has no such card', async () => {
    const { base, asked } = await setUp({ showAnyCard: { execute: async () => err({ code: 'NO_SUCH_CARD' }) } });
    assert.deepEqual(await answer(await fetch(`${base}/lookup/search?q=%20charizard%204/102%20`, as('viewer'))), [200, { hits: [], more: false }]);
    assert.deepEqual(asked, [{ query: 'charizard 4/102' }]);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/search?q=%20`, as('viewer'))), [400, { error: 'Type a card name, set or number.', code: 'invalid_argument' }]);
    const missing = [404, { error: 'No such card in the card database.', code: 'not_found' }];
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/no-such-card`, as('viewer'))), missing);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/bad%20id`, as('viewer'))), missing);
  });
});

describe("a card's details before its prices", () => {
  it('are for viewers, and ask only for the card', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/base1-4/details`)), [401, { error: 'Please sign in', code: 'signin' }]);
    assert.deepEqual(asked, []);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/base1-4/details`, as('viewer'))), [200, { id: 'base1-4' }]);
    assert.deepEqual(asked, [{ id: 'base1-4' }]);
  });

  it('say when there is no such card, or the id cannot be one', async () => {
    const { base } = await setUp({ showAnyCardDetails: { execute: async () => err({ code: 'NO_SUCH_CARD' }) } });
    const missing = [404, { error: 'No such card in the card database.', code: 'not_found' }];
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/no-such-card/details`, as('viewer'))), missing);
    const bad = await setUp();
    assert.deepEqual(await answer(await fetch(`${bad.base}/lookup/cards/bad%20id/details`, as('viewer'))), missing);
    assert.deepEqual(bad.asked, []);
  });
});

describe('master set routes', () => {
  it('list the sets, and preview one', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/master-sets/sets`, as('editor'))), [200, { sets: [] }]);
    assert.deepEqual(await answer(await fetch(`${base}/master-sets/preview?set=%20Celebrations%20`, as('editor'))), [200, { title: 'Celebrations' }]);
    assert.deepEqual(asked, [undefined, { set: 'Celebrations' }]);
    assert.deepEqual(await answer(await fetch(`${base}/master-sets/preview?pokemon=Pikachu`, as('editor'))), [400, { error: 'Type the set.', code: 'invalid_argument' }]);
  });

  it('make a master set, with what the page sent tidied', async () => {
    const { base, asked } = await setUp();
    const r = await fetch(`${base}/master-sets`, as('editor', json({ set: ' Celebrations ', owner: 'Maiya', name: ' My set ', pockets: 9, extra: 'ignored' })));
    assert.deepEqual(await answer(r), [201, { binderId: 'b1', cards: 48, pages: 6 }]);
    assert.deepEqual(asked, [{ actor: 'justin', set: 'Celebrations', owner: 'Maiya', name: 'My set', color: null, pockets: 9, extras: false }]);
    const refused = [400, { error: 'Give the set, its owner, a binder name and the pockets per page.', code: 'invalid_argument' }];
    const good = { set: 'Celebrations', owner: 'Megan', name: 'Set', pockets: 9 };
    for (const body of [{ ...good, pockets: 10 }, { ...good, set: ' ' }, { ...good, name: 'x'.repeat(41) }, { ...good, owner: 'x'.repeat(21) }, { ...good, color: null }, { ...good, extras: 'yes' }, { pokemon: "Farfetch'd", owner: 'Megan', name: 'Set', pockets: 9 }, [good]])
      assert.deepEqual(await answer(await fetch(`${base}/master-sets`, as('editor', json(body)))), refused, JSON.stringify(body));
    assert.equal(asked.length, 1);
  });

  it("map a master set's errors to statuses and words", async () => {
    const cases = [
      [{ code: 'SET_NOT_FOUND', query: 'Not a set' }, 404, { error: 'No set called “Not a set” was found. Pick one from the list.', code: 'not_found' }],
      [{ code: 'SET_HAS_NO_CARDS', title: 'Mega Evolution' }, 404, { error: 'The card database has no cards for Mega Evolution yet.', code: 'not_found' }],
      [DOWN, 502, { error: "The card database (TCGdex) didn't answer. Try again in a minute.", code: 'upstream_error' }],
    ] as const;
    const body = json({ set: 'x', owner: '', name: 'x', pockets: 4 });
    for (const [error, status, failure] of cases) {
      const { base } = await setUp({ previewMasterSet: { execute: async () => err(error) }, createMasterSet: { execute: async () => err(error) } });
      assert.deepEqual(await answer(await fetch(`${base}/master-sets/preview?set=x`, as('editor'))), [status, failure]);
      assert.deepEqual(await answer(await fetch(`${base}/master-sets`, as('editor', body))), [status, failure]);
    }
    // A card the ledger refuses (an owner it doesn't know): nothing was made.
    const { base } = await setUp({ createMasterSet: { execute: async () => err({ code: 'INVALID_DOCUMENT', message: 'owner: Expected one of ""' } as const) } });
    assert.deepEqual(await answer(await fetch(`${base}/master-sets`, as('editor', body))), [400, { error: 'owner: Expected one of ""', code: 'invalid_argument' }]);
  });

  it('are heavy for editors: the stricter rate limit applies to those they serve', async () => {
    const { routes } = await setUp();
    assert.deepEqual(routes.heavyLimit('POST', '/master-sets'), { role: 'editor' });
    assert.deepEqual(routes.heavyLimit('GET', '/master-sets/preview'), { role: 'editor' });
    assert.deepEqual(routes.heavyLimit('POST', '/cards/fill-details'), { role: 'editor' });
    assert.equal(routes.heavyLimit('GET', '/master-sets/sets'), null);
    assert.equal(routes.heavyLimit('GET', '/cards/lookup'), null);
  });
});

describe('with card lookups turned off', () => {
  it('every route answers 503, after checking the request it needs to', async () => {
    const { base } = await setUp({}, true);
    const off = [503, { error: 'Card lookups are turned off on this server.', code: 'invalid_argument' }];
    const anyOff = [503, { error: 'Card lookups are turned off on this server.', code: 'unavailable' }];
    assert.deepEqual(await answer(await fetch(`${base}/cards/lookup`, as('editor'))), off);
    assert.deepEqual(await answer(await fetch(`${base}/cards/c1/details`, as('editor', json({})))), off);
    assert.deepEqual(await answer(await fetch(`${base}/cards/fill-details`, as('editor', { method: 'POST' }))), off);
    assert.deepEqual(await answer(await fetch(`${base}/master-sets/sets`, as('editor'))), off);
    assert.deepEqual(await answer(await fetch(`${base}/master-sets/preview?set=151`, as('editor'))), off);
    assert.deepEqual(await answer(await fetch(`${base}/master-sets`, as('editor', json({ set: '151', owner: '', name: 'x', pockets: 9 })))), off);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/search?q=pikachu`, as('viewer'))), anyOff);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/base1-4`, as('viewer'))), anyOff);
    assert.deepEqual(await answer(await fetch(`${base}/lookup/cards/base1-4/details`, as('viewer'))), anyOff);
    // What's wrong with the request first.
    assert.equal((await fetch(`${base}/lookup/search?q=`, as('viewer'))).status, 400);
    assert.equal((await fetch(`${base}/lookup/cards/bad%20id`, as('viewer'))).status, 404);
    assert.equal((await fetch(`${base}/master-sets/preview`, as('editor'))).status, 400);
    assert.equal((await fetch(`${base}/master-sets`, as('editor', json({})))).status, 400);
  });
});
