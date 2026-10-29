import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeleteDocument } from '#application/ledger/delete-document.ts';
import { MergeDocument } from '#application/ledger/merge-document.ts';
import { PutDocument } from '#application/ledger/put-document.ts';
import { ReadLedger } from '#application/ledger/read-ledger.ts';
import { card, NOW, setUp } from '../fixtures.ts';

describe('PutDocument', () => {
  it('creates a card and publishes that it was saved', async () => {
    const { ledger, deps, published } = setUp();
    const r = await new PutDocument(deps).execute({ collection: 'cards', id: 'c1', doc: card() });
    assert.deepEqual(r, { ok: true, value: { id: 'c1', ...card() } });
    assert.deepEqual(ledger.tables.cards.get('c1'), card());
    assert.deepEqual(published, [{ type: 'DocumentSaved', collection: 'cards', id: 'c1', occurredAt: NOW }]);
  });

  it('refuses a new card in a pocket holding a different card, and saves nothing', async () => {
    const { ledger, deps, published } = setUp();
    ledger.seed('cards', 'c1', card({ name: 'Charizard', number: '4/102' }));
    const r = await new PutDocument(deps).execute({ collection: 'cards', id: 'c2', doc: card() });
    assert.deepEqual(r, { ok: false, error: { code: 'POCKET_HOLDS_ANOTHER_CARD', name: 'Charizard' } });
    assert.equal(ledger.tables.cards.has('c2'), false);
    assert.deepEqual(published, []);
    assert.deepEqual(ledger.runs, [{ committed: false }]);
  });

  it('puts a copy of the same card in the pocket, and saves a card again without checking its pocket', async () => {
    const { ledger, deps } = setUp();
    ledger.seed('cards', 'c1', card({ condition: 'NM' }));
    const put = new PutDocument(deps);
    assert.equal((await put.execute({ collection: 'cards', id: 'c2', doc: card({ condition: 'LP', owner: 'Megan' }) })).ok, true);
    // A different card sitting in a pocket from older data is still saved when its place is unchanged.
    ledger.seed('cards', 'c3', card({ name: 'Pikachu', number: '58/102' }));
    assert.equal((await put.execute({ collection: 'cards', id: 'c3', doc: card({ name: 'Pikachu', number: '58/102', notes: 'edited' }) })).ok, true);
    assert.equal(ledger.tables.cards.get('c3')?.['notes'], 'edited');
  });

  it('replaces a document whole', async () => {
    const { ledger, deps } = setUp();
    ledger.seed('binders', 'b1', { name: 'Old', color: 'red' });
    await new PutDocument(deps).execute({ collection: 'binders', id: 'b1', doc: { name: 'New' } });
    assert.deepEqual(ledger.tables.binders.get('b1'), { name: 'New' });
  });

  it('saves nothing and publishes nothing when the document is refused', async () => {
    const { ledger, deps, published } = setUp();
    const r = await new PutDocument(deps).execute({ collection: 'cards', id: 'c1', doc: card({ page: 0 }) });
    assert.deepEqual(r, { ok: false, error: { code: 'INVALID_DOCUMENT', message: 'page: Too small: at least 1' } });
    assert.equal(ledger.tables.cards.size, 0);
    assert.deepEqual(published, []);
    assert.deepEqual(ledger.runs, [{ committed: false }]);
  });

  it('checks the address: collection, id, and settings the page may write', async () => {
    const { ledger, deps } = setUp();
    const put = new PutDocument(deps);
    assert.deepEqual(await put.execute({ collection: 'users', id: 'u1', doc: {} }), { ok: false, error: { code: 'NO_SUCH_COLLECTION' } });
    assert.deepEqual(await put.execute({ collection: 'cards', id: 'bad id', doc: card() }), { ok: false, error: { code: 'INVALID_ID', id: 'bad id' } });
    assert.deepEqual(await put.execute({ collection: 'settings', id: 'pricing', doc: {} }), { ok: false, error: { code: 'SETTING_BELONGS_TO_SERVER' } });
    assert.equal((await put.execute({ collection: 'settings', id: 'main', doc: { usdToCad: 1.41 } })).ok, true);
    assert.deepEqual(ledger.tables.settings.get('main'), { usdToCad: 1.41 });
    assert.deepEqual(ledger.runs, [{ committed: true }]);
  });
});

describe('MergeDocument', () => {
  it('changes some fields and keeps the rest', async () => {
    const { ledger, deps, published } = setUp();
    ledger.seed('cards', 'c1', card());
    const r = await new MergeDocument(deps).execute({ collection: 'cards', id: 'c1', patch: { status: 'sold', binderId: null, page: null, slot: null } });
    assert.deepEqual(r, { ok: true, value: { id: 'c1', ...card({ status: 'sold', binderId: null, page: null, slot: null }) } });
    assert.equal(published.length, 1);
  });

  it('moves a card into a pocket with its copies, and refuses a different card there', async () => {
    const { ledger, deps } = setUp();
    ledger.seed('cards', 'a', card({ slot: 1 }));
    ledger.seed('cards', 'b', card({ slot: 2, condition: 'LP' }));
    ledger.seed('cards', 'p', card({ name: 'Pikachu', number: '58/102', slot: 3 }));
    const merge = new MergeDocument(deps);
    assert.equal((await merge.execute({ collection: 'cards', id: 'a', patch: { slot: 2 } })).ok, true);
    assert.equal(ledger.tables.cards.get('a')?.['slot'], 2);
    assert.deepEqual(await merge.execute({ collection: 'cards', id: 'p', patch: { slot: 2 } }), { ok: false, error: { code: 'POCKET_HOLDS_ANOTHER_CARD', name: 'Lapras' } });
    assert.equal(ledger.tables.cards.get('p')?.['slot'], 3);
  });

  it('never refuses a change that leaves the place alone, even inside a mixed pocket', async () => {
    const { ledger, deps } = setUp();
    ledger.seed('cards', 'a', card());
    ledger.seed('cards', 'p', card({ name: 'Pikachu', number: '58/102' }));
    const r = await new MergeDocument(deps).execute({ collection: 'cards', id: 'a', patch: { name: 'Lapras ex' } });
    assert.equal(r.ok, true);
    assert.equal(ledger.tables.cards.get('a')?.['name'], 'Lapras ex');
  });

  it('refuses a document that is not there', async () => {
    const { deps } = setUp();
    assert.deepEqual(await new MergeDocument(deps).execute({ collection: 'cards', id: 'missing', patch: { name: 'x' } }), { ok: false, error: { code: 'DOCUMENT_NOT_FOUND', collection: 'cards', id: 'missing' } });
  });

  it('leaves the document as it was when the result is refused', async () => {
    const { ledger, deps } = setUp();
    ledger.seed('cards', 'c1', card());
    const r = await new MergeDocument(deps).execute({ collection: 'cards', id: 'c1', patch: { placeholder: 'yes' } });
    assert.equal(r.ok, false);
    assert.deepEqual(ledger.tables.cards.get('c1'), card());
  });
});

describe('DeleteDocument', () => {
  it('deletes, and a document already gone is fine', async () => {
    const { ledger, deps, published } = setUp();
    ledger.seed('cards', 'c1', card());
    const del = new DeleteDocument(deps);
    assert.deepEqual(await del.execute({ collection: 'cards', id: 'c1' }), { ok: true, value: undefined });
    assert.deepEqual(await del.execute({ collection: 'cards', id: 'c1' }), { ok: true, value: undefined });
    assert.equal(ledger.tables.cards.size, 0);
    assert.deepEqual(published, [{ type: 'DocumentDeleted', collection: 'cards', id: 'c1', occurredAt: NOW }]);
    assert.deepEqual(await del.execute({ collection: 'settings', id: 'pricing' }), { ok: false, error: { code: 'SETTING_BELONGS_TO_SERVER' } });
  });
});

describe('ReadLedger', () => {
  it('reads every binder, card and setting with its id', async () => {
    const { ledger, deps } = setUp();
    ledger.seed('binders', 'b1', { name: 'IR' });
    ledger.seed('cards', 'c1', card());
    assert.deepEqual(await new ReadLedger(deps).execute(), { binders: [{ id: 'b1', name: 'IR' }], cards: [{ id: 'c1', ...card() }], settings: [] });
  });
});

describe('changing a binder’s pockets per page', () => {
  it('moves its cards in the same unit of work, keeping their order, and sends them to open pages', async () => {
    const { ledger, deps, published } = setUp();
    ledger.seed('binders', 'b1', { name: 'Trainers', pockets: 9 });
    ledger.seed('cards', 'c1', card({ page: 1, slot: 4 }));
    ledger.seed('cards', 'c2', card({ page: 1, slot: 7 }));
    ledger.seed('cards', 'c3', card({ binderId: 'b2', page: 1, slot: 7 }));
    const r = await new MergeDocument(deps).execute({ collection: 'binders', id: 'b1', patch: { pockets: 4 } });
    assert.equal(r.ok, true);
    assert.deepEqual(ledger.tables.binders.get('b1'), { name: 'Trainers', pockets: 4 });
    assert.deepEqual(ledger.tables.cards.get('c1'), card({ page: 1, slot: 4 }));
    assert.deepEqual(ledger.tables.cards.get('c2'), card({ page: 2, slot: 3, updatedAt: NOW.toISOString() }));
    assert.deepEqual(ledger.tables.cards.get('c3'), card({ binderId: 'b2', page: 1, slot: 7 }));
    assert.deepEqual(published.map((e) => `${e.collection}/${e.id}`), ['binders/b1', 'cards/c2']);
    assert.deepEqual(ledger.runs, [{ committed: true }]);
  });

  it('sends the binder to open pages once when its saved layout moves too', async () => {
    const { ledger, deps, published } = setUp();
    ledger.seed('binders', 'b1', { name: 'Trainers', pockets: 9, layout: { savedAt: '2026-01-01T00:00:00.000Z', places: [{ id: 'c1', page: 1, slot: 6 }] } });
    ledger.seed('cards', 'c1', card({ page: 1, slot: 6 }));
    await new MergeDocument(deps).execute({ collection: 'binders', id: 'b1', patch: { pockets: 4 } });
    assert.deepEqual(ledger.tables.binders.get('b1'), { name: 'Trainers', pockets: 4, layout: { savedAt: '2026-01-01T00:00:00.000Z', places: [{ id: 'c1', page: 2, slot: 2 }] } });
    assert.deepEqual(published.map((e) => `${e.collection}/${e.id}`), ['binders/b1', 'cards/c1']);
  });

  it('does the same when the binder is saved whole', async () => {
    const { ledger, deps } = setUp();
    ledger.seed('binders', 'b1', { name: 'Trainers', pockets: 4 });
    ledger.seed('cards', 'c1', card({ page: 2, slot: 1 }));
    await new PutDocument(deps).execute({ collection: 'binders', id: 'b1', doc: { name: 'Trainers', pockets: 9 } });
    assert.deepEqual(ledger.tables.cards.get('c1'), card({ page: 1, slot: 5, updatedAt: NOW.toISOString() }));
  });

  it('leaves the cards alone when only the name changes', async () => {
    const { ledger, deps, published } = setUp();
    ledger.seed('binders', 'b1', { name: 'Trainers', pockets: 4 });
    ledger.seed('cards', 'c1', card({ page: 2, slot: 3 }));
    await new MergeDocument(deps).execute({ collection: 'binders', id: 'b1', patch: { name: 'Gym' } });
    assert.deepEqual(ledger.tables.cards.get('c1'), card({ page: 2, slot: 3 }));
    assert.equal(published.length, 1);
  });
});
