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
