import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Event, InvalidDoc, NotFound, validateDoc } from '#infrastructure/json-store/store.ts';
import { readFile, tempStore } from './fixtures.ts';

describe('Store', () => {
  it('saves several documents of any collection as one change, in order, and tells subscribers', () => {
    const store = tempStore();
    store.set('cards', 'gone', { name: 'Old' });
    const seen: Event[] = [];
    store.subscribe((e) => seen.push(e));
    const before = store.version;
    store.transact([
      { collection: 'cards', id: 'c1', doc: { name: 'Mew' } },
      { collection: 'binders', id: 'b1', doc: { name: 'IR' } },
      { collection: 'cards', id: 'gone', doc: null },
    ]);
    assert.equal(store.version, before + 1);
    assert.deepEqual(readFile(store), { binders: { b1: { name: 'IR' } }, cards: { c1: { name: 'Mew' } }, settings: {} });
    assert.deepEqual(
      seen.map((e) => (e.type === 'change' ? `${e.change.collection}/${e.change.id}` : e.type)),
      ['cards/c1', 'binders/b1', 'cards/gone'],
    );
  });

  it('changes nothing for an empty change', () => {
    const store = tempStore();
    const before = store.version;
    store.transact([]);
    assert.equal(store.version, before);
  });

  it('still checks documents the Express code writes directly, with the domain rules', () => {
    const store = tempStore();
    assert.throws(() => store.set('cards', 'c1', { page: 0 }), (e) => e instanceof InvalidDoc && e.message === 'page: Too small: at least 1');
    assert.throws(() => store.update('cards', 'missing', {}), (e) => e instanceof NotFound && e.message === 'No card with id missing');
    assert.deepEqual(validateDoc('binders', { id: 'b1', name: 'IR' }), { name: 'IR' });
  });
});
