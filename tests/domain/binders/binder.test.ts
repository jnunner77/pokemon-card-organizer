import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Binder, type BinderId } from '#domain/binders/binder.ts';
import { AT, binder, value } from '../fixtures.ts';

describe('Binder', () => {
  it('is created from a valid document and needs a name', () => {
    const b = value(Binder.create('b1' as BinderId, { name: 'IR', pockets: 4 }, AT));
    assert.deepEqual(b.toSnapshot(), { id: 'b1', fields: { name: 'IR', pockets: 4 } });
    assert.equal(b.pullEvents().length, 1);
    assert.deepEqual(Binder.create('b2' as BinderId, { color: 'red' }, AT), { ok: false, error: { code: 'INVALID_DOCUMENT', message: 'name: Required' } });
  });

  it('has pages of 4, 9, 12 or 16 pockets, else 9', () => {
    for (const pockets of [4, 9, 12, 16]) assert.equal(binder('b', { pockets }).pocketsPerPage, pockets);
    for (const pockets of [3, 64, undefined]) assert.equal(binder('b', { pockets }).pocketsPerPage, 9);
  });

  it('may be a display case', () => {
    assert.equal(binder('b', { kind: 'case' }).isCase, true);
    assert.equal(binder('b').isCase, false);
    assert.equal(binder('b').name, 'Trainers');
  });

  it('tells which pockets a card can sit in', () => {
    const b = binder('b', { pockets: 4 });
    assert.equal(b.fits(1, 4), true);
    assert.equal(b.fits(1, 5), false);
    assert.equal(b.fits(0, 1), false);
    assert.equal(b.fits(null, 1), false);
  });

  it('saves a layout', () => {
    const b = binder('b');
    value(b.saveLayout([{ id: 'c1', page: 1, slot: 1 }], AT));
    assert.deepEqual(b.fields['layout'], { savedAt: AT.toISOString(), places: [{ id: 'c1', page: 1, slot: 1 }] });
  });

  it('is merged and replaced, and records its deletion', () => {
    const b = binder('b');
    value(b.merge({ color: '#fff' }, AT));
    assert.deepEqual(b.fields, { name: 'Trainers', pockets: 9, color: '#fff' });
    assert.equal(b.replace({ color: '#000' }, AT).ok, false);
    b.delete(AT);
    assert.deepEqual(b.pullEvents().map((e) => e.type), ['DocumentSaved', 'DocumentDeleted']);
  });
});

describe('a binder’s saved layout', () => {
  it('reads its places and moves them, keeping when it was saved', () => {
    const b = binder('b1', { layout: { savedAt: '2026-01-01T00:00:00.000Z', places: [{ id: 'a', page: 1, slot: 2 }] } });
    assert.deepEqual(b.layoutPlaces, [{ id: 'a', page: 1, slot: 2 }]);
    value(b.moveLayout([{ id: 'a', page: 3, slot: 1 }], AT));
    assert.deepEqual(b.fields['layout'], { savedAt: '2026-01-01T00:00:00.000Z', places: [{ id: 'a', page: 3, slot: 1 }] });
  });

  it('has no places without a layout, and moving them changes nothing', () => {
    const b = binder('b1');
    assert.deepEqual(b.layoutPlaces, []);
    value(b.moveLayout([], AT));
    assert.equal(b.fields['layout'], undefined);
    assert.deepEqual(b.pullEvents(), []);
  });
});
