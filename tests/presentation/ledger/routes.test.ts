import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Caller } from '#application/access.ts';
import { err, ok } from '#shared/result.ts';
import { ledgerRoutes, type LedgerRouteDeps } from '#presentation/ledger/routes.ts';
import { json, serve } from '../fixtures.ts';

const unused = { execute: async () => assert.fail('not expected to run') };

/** Routes with use cases that record what they were asked; the caller comes from the X-Role header. */
async function setUp(over: Partial<LedgerRouteDeps> = {}) {
  const asked: unknown[] = [];
  const record = <T>(answer: T) => ({ execute: async (input?: unknown) => (asked.push(input), answer) });
  const routes = ledgerRoutes({
    identify: (req) => {
      const role = req.headers['x-role'];
      return role === 'viewer' || role === 'editor' || role === 'admin' ? ({ name: 'justin', role } satisfies Caller) : null;
    },
    readLedger: { execute: async () => ({ binders: [], cards: [], settings: [] }) },
    putDocument: record(ok({ id: 'c1', name: 'Mew' })),
    mergeDocument: record(err({ code: 'DOCUMENT_NOT_FOUND', collection: 'cards', id: 'c1' } as const)),
    deleteDocument: record(ok(undefined)),
    changePriceEntries: record(ok({ id: 'c1' })),
    arrangeBinder: record(ok({ moved: 1, cards: 2, layoutSaved: null })),
    placeCards: record(err({ code: 'POCKET_TAKEN' } as const)),
    recordTrade: record(ok({ cards: [{ id: 'c1' }], deleted: [] })),
    undoTrade: record(err({ code: 'TRADE_NOT_FOUND' } as const)),
    ...over,
  });
  return { base: await serve(routes.handle), asked };
}

const as = (role: string, init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers);
  headers.set('X-Role', role);
  return { ...init, headers };
};

describe('ledger routes', () => {
  it('needs a signed-in caller, and an editor to change anything, before reading the request', async () => {
    const { base, asked } = await setUp();
    const r = await fetch(`${base}/docs/cards/c1`, json({ name: 'Mew' }, 'PUT'));
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'Please sign in', code: 'signin' });
    const v = await fetch(`${base}/docs/cards/c1`, as('viewer', json({ name: 'Mew' }, 'PUT')));
    assert.equal(v.status, 403);
    assert.deepEqual(await v.json(), { error: 'You have view-only access.', code: 'forbidden' });
    assert.equal((await fetch(`${base}/data`, as('viewer'))).status, 200);
    assert.deepEqual(asked, []);
  });

  it('passes the document on and answers with it', async () => {
    const { base, asked } = await setUp();
    const r = await fetch(`${base}/docs/cards/c1`, as('editor', json({ name: 'Mew' }, 'PUT')));
    assert.deepEqual([r.status, await r.json()], [200, { id: 'c1', name: 'Mew' }]);
    assert.deepEqual(asked, [{ collection: 'cards', id: 'c1', doc: { name: 'Mew' } }]);
  });

  it('maps the use case’s errors to statuses and words', async () => {
    const { base } = await setUp({ arrangeBinder: { execute: async () => err({ code: 'ARRANGEMENT_UNREADABLE' } as const) } });
    const sort = await fetch(`${base}/binders/b1/arrange`, as('editor', json({ moves: 'all' })));
    assert.deepEqual([sort.status, await sort.json()], [400, { error: 'Send each card with its page and pocket.', code: 'invalid_argument' }]);
    const merged = await fetch(`${base}/docs/cards/c1`, as('editor', json({ name: 'x' }, 'PATCH')));
    assert.deepEqual([merged.status, await merged.json()], [404, { error: 'No card with id c1', code: 'not_found' }]);
    const placed = await fetch(`${base}/cards/place`, as('editor', json({ moves: [{ id: 'c1', binderId: 'b1', page: 1, slot: 1 }] })));
    assert.deepEqual([placed.status, await placed.json()], [409, { error: 'A pocket was filled meanwhile, so nothing moved. Try again.', code: 'conflict' }]);
  });

  it('refuses bodies it cannot read', async () => {
    const { base } = await setUp();
    const bad = await fetch(`${base}/docs/cards/c1`, as('editor', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{nope' }));
    assert.deepEqual([bad.status, await bad.json()], [400, { error: "The request body isn't valid JSON", code: 'invalid_argument' }]);
    const big = await fetch(`${base}/docs/cards/c1`, as('editor', json({ notes: 'x'.repeat(1024 * 1024) }, 'PUT')));
    assert.deepEqual([big.status, await big.json()], [413, { error: 'That upload is too large', code: 'too_large' }]);
    const prices = await fetch(`${base}/cards/c1/prices`, as('editor', json({ add: 'x' })));
    assert.deepEqual([prices.status, await prices.json()], [400, { error: 'Send the price entries to add, change or remove.', code: 'invalid_argument' }]);
    const badId = await fetch(`${base}/cards/bad%20id/prices`, as('editor', json({ add: 'x' })));
    assert.deepEqual([badId.status, await badId.json()], [400, { error: 'Ids are letters, digits, - and _ (at most 64)', code: 'invalid_argument' }]);
    const place = await fetch(`${base}/cards/place`, as('editor', json({ moves: [] })));
    assert.deepEqual([place.status, await place.json()], [400, { error: 'Send each card with its binder, page and pocket.', code: 'invalid_argument' }]);
  });

  it('answers a sort without layoutSaved unless the layout was saved, and passes who sorted it', async () => {
    const { base, asked } = await setUp();
    const r = await fetch(`${base}/binders/b1/arrange`, as('editor', json({ moves: [{ id: 'c1', page: 1, slot: 1 }] })));
    assert.deepEqual(await r.json(), { moved: 1, cards: 2 });
    await fetch(`${base}/binders/b1/arrange`, as('editor', json({ moves: 'all' })));
    assert.deepEqual(asked, [
      { actor: 'justin', binderId: 'b1', arrangement: { moves: [{ cardId: 'c1', page: 1, slot: 1 }], saveLayout: false } },
      // An unreadable arrangement still goes to the use case, which reports a missing binder first.
      { actor: 'justin', binderId: 'b1', arrangement: null },
    ]);
    const missing = await fetch(`${base}/binders/bad%20id/arrange`, as('editor', json({ moves: [] })));
    assert.deepEqual([missing.status, await missing.json()], [404, { error: 'That binder no longer exists.', code: 'not_found' }]);
  });

  it('deletes with no content', async () => {
    const { base } = await setUp({ mergeDocument: unused });
    assert.equal((await fetch(`${base}/docs/cards/c1`, as('editor', { method: 'DELETE' }))).status, 204);
  });

  it('records a trade for an editor, with who recorded it, and undoes one by its id', async () => {
    const { base, asked } = await setUp();
    const trade = { id: 't1', given: [{ id: 'c1', sale: { soldCAD: 10 }, entry: { id: 'p1', type: 'mysale', amount: 10 } }], received: [{ id: 'n1', binderId: null, doc: { name: 'Mew' } }, { id: 'ph', placeholder: true, grader: 'PSA', grade: '10' }] };
    assert.equal((await fetch(`${base}/trades`, as('viewer', json(trade)))).status, 403);
    const r = await fetch(`${base}/trades`, as('editor', json(trade)));
    assert.deepEqual([r.status, await r.json()], [200, { cards: [{ id: 'c1' }], deleted: [] }]);
    assert.deepEqual(asked, [
      {
        actor: 'justin',
        tradeId: 't1',
        summary: {},
        given: [{ cardId: 'c1', sale: { soldCAD: 10 }, entry: { id: 'p1', type: 'mysale', amount: 10 } }],
        received: [
          { kind: 'new', cardId: 'n1', doc: { name: 'Mew' }, binderId: null, entries: [] },
          { kind: 'placeholder', cardId: 'ph', grader: 'PSA', grade: '10', entries: [] },
        ],
      },
    ]);
    const undo = await fetch(`${base}/trades/t1`, as('editor', { method: 'DELETE' }));
    assert.deepEqual([undo.status, await undo.json()], [404, { error: 'That trade is already undone.', code: 'not_found' }]);
  });

  it('refuses a trade it cannot read', async () => {
    const { base, asked } = await setUp();
    for (const bad of [{ given: [], received: [] }, { id: 't1', given: [{ id: 'c1' }], received: [] }, { id: 't1', given: [], received: [{ id: 'n1', binderId: 'bad id', doc: {} }] }, { id: 't1', given: [], received: [{ id: 'n1', placeholder: 'yes' }] }, { id: 't1', summary: 'x', given: [], received: [] }]) {
      const r = await fetch(`${base}/trades`, as('editor', json(bad)));
      assert.deepEqual([r.status, await r.json()], [400, { error: 'Send the trade with its id, the cards given and the cards received.', code: 'invalid_argument' }]);
    }
    const badId = await fetch(`${base}/trades/bad%20id`, as('editor', { method: 'DELETE' }));
    assert.equal(badId.status, 400);
    assert.deepEqual(asked, []);
  });
});
