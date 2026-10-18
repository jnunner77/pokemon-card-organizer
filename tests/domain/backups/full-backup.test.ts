import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BACKUP_FORMAT, checkBackupPhoto, fullBackup, readFullBackup, readLedgerCopy } from '#domain/backups/full-backup.ts';

const AT = new Date('2026-10-18T12:00:00.000Z');
const photoId = 'a'.repeat(32);
const valid = (over: Record<string, unknown> = {}) => ({ format: BACKUP_FORMAT, version: 1, binders: { b1: { name: 'IR' } }, cards: { c1: { name: 'Mew', slot: 1 } }, settings: {}, assets: { [photoId]: { type: 'image/jpeg', data: '/9j/' } }, ...over });
const refused = (input: unknown) => {
  const r = readFullBackup(input);
  assert.ok(!r.ok, 'expected the backup to be refused');
  return r.error.message;
};

describe('full backups', () => {
  it('hold every document and photo, with the format and when it was made', () => {
    const backup = fullBackup({ binders: { b1: { name: 'IR' } }, cards: {}, settings: {} }, { [photoId]: { type: 'image/png', data: 'AA==' } }, AT);
    assert.deepEqual(backup, { format: BACKUP_FORMAT, version: 1, exportedAt: AT.toISOString(), binders: { b1: { name: 'IR' } }, cards: {}, settings: {}, assets: { [photoId]: { type: 'image/png', data: 'AA==' } } });
  });

  it('are read back with every document checked', () => {
    assert.deepEqual(readFullBackup(valid()), { ok: true, value: { ledger: { binders: { b1: { name: 'IR' } }, cards: { c1: { name: 'Mew', slot: 1 } }, settings: {} }, photos: { [photoId]: { type: 'image/jpeg', data: '/9j/' } } } });
    assert.equal(readFullBackup(valid({ assets: undefined })).ok, true);
  });

  it('refuse what is not one of ours, or from a newer version', () => {
    assert.equal(refused({ hello: 'world' }), "format: That file isn't a Pokémon Binder Ledger backup");
    assert.equal(refused(undefined), "format: That file isn't a Pokémon Binder Ledger backup");
    assert.equal(refused(valid({ version: 2 })), 'version: That backup was made by a newer version of this app');
    assert.equal(refused(valid({ version: '1' })), 'version: Expected a whole number');
  });

  it('say which document or photo entry is wrong', () => {
    assert.equal(refused(valid({ cards: { c1: { name: 'Mew', slot: -3 } } })), 'cards.c1: slot: Too small: at least 1');
    assert.equal(refused(valid({ cards: [] })), 'cards: Expected an object');
    assert.equal(refused(valid({ binders: { 'bad id': { name: 'x' } } })), 'binders.bad id: Ids are letters, digits, - and _ (at most 64)');
    assert.equal(refused(valid({ assets: { nope: { type: 'image/jpeg', data: '' } } })), 'assets.nope: Photo ids are 32 hex characters');
    assert.equal(refused(valid({ assets: { [photoId]: { type: 'image/jpeg' } } })), `assets.${photoId}.data: Expected text`);
  });

  it('check each photo once decoded', () => {
    assert.deepEqual(checkBackupPhoto(photoId, new Uint8Array([0xff, 0xd8, 0xff, 0])), { ok: true, value: 'image/jpeg' });
    assert.deepEqual(checkBackupPhoto(photoId, new Uint8Array()), { ok: false, error: { code: 'INVALID_BACKUP', message: `assets.${photoId}: the photo is empty` } });
    assert.deepEqual(checkBackupPhoto(photoId, new TextEncoder().encode('nope')), { ok: false, error: { code: 'INVALID_BACKUP', message: `assets.${photoId}: that isn't a JPG, PNG, WebP or GIF picture` } });
  });
});

describe('kept copies of the ledger', () => {
  it('are read with each document checked; missing collections are empty', () => {
    assert.deepEqual(readLedgerCopy({ cards: { c1: { name: 'Mew' } } }), { ok: true, value: { binders: {}, cards: { c1: { name: 'Mew' } }, settings: {} } });
    assert.deepEqual(readLedgerCopy({ binders: { b1: { color: 'red' } } }), { ok: false, error: { code: 'INVALID_DOCUMENT', message: 'name: Required' } });
  });

  it('refuse a damaged copy instead of reading it as an empty ledger', () => {
    assert.deepEqual(readLedgerCopy(null), { ok: false, error: { code: 'INVALID_DOCUMENT', message: "That copy of the ledger isn't a JSON object" } });
    assert.deepEqual(readLedgerCopy([]), { ok: false, error: { code: 'INVALID_DOCUMENT', message: "That copy of the ledger isn't a JSON object" } });
    assert.deepEqual(readLedgerCopy({ cards: 'damaged' }), { ok: false, error: { code: 'INVALID_DOCUMENT', message: 'cards: Expected an object' } });
  });
});
