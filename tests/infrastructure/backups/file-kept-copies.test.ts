import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Housekeeping } from '#application/backups/housekeeping.ts';
import { PruneCopies } from '#application/backups/prune-copies.ts';
import { RestoreCopy } from '#application/backups/restore-copy.ts';
import { DEFAULT_RETENTION } from '#domain/backups/retention.ts';
import { FileKeptCopies } from '#infrastructure/backups/file-kept-copies.ts';
import { StoreWholeLedger } from '#infrastructure/json-store/whole-ledger.ts';
import { FilePhotoStore } from '#infrastructure/photos/file-photo-store.ts';
import { PhotoFiles } from '#infrastructure/photos/photo-files.ts';
import { tempStore } from '../json-store/fixtures.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);

describe('FileKeptCopies', () => {
  it('lists, reads, writes and removes copies, and copies the ledger file as it is', async () => {
    const store = tempStore();
    const copies = new FileKeptCopies(store.backupDir, store.file);
    assert.equal(await copies.copyLedgerFile('db-2026-10-17.json'), false); // no ledger file yet
    store.set('cards', 'c1', { name: 'Mew' });
    assert.equal(await copies.copyLedgerFile('db-2026-10-17.json'), true);
    await copies.writeLedger('db-snapshot-x-label.json', { binders: {}, cards: {}, settings: {} });
    fs.writeFileSync(path.join(store.backupDir, 'notes.txt'), 'not a copy');
    assert.deepEqual((await copies.list()).map((c) => c.name).sort(), ['db-2026-10-17.json', 'db-snapshot-x-label.json']);
    assert.deepEqual(JSON.parse((await copies.read('db-2026-10-17.json')) ?? ''), { binders: {}, cards: { c1: { name: 'Mew' } }, settings: {} });
    assert.equal(await copies.read('db-2020-01-01.json'), null);
    await copies.remove('db-snapshot-x-label.json');
    assert.deepEqual((await copies.list()).map((c) => c.name), ['db-2026-10-17.json']);
  });

  it('never reaches a file that is not a copy', async () => {
    const store = tempStore();
    const copies = new FileKeptCopies(store.backupDir, store.file);
    fs.writeFileSync(path.join(store.dataDir, 'auth.json'), 'secret');
    assert.equal(await copies.read('../auth.json'), null);
    await copies.remove('../auth.json');
    assert.equal(fs.existsSync(path.join(store.dataDir, 'auth.json')), true);
    await assert.rejects(copies.writeLedger('../auth.json', { binders: {}, cards: {}, settings: {} }), /isn't a name for a copy/);
  });
});

describe('photos, copies and the ledger together, on disk', () => {
  // Moved from "keeps a trashed photo while any kept copy refers to it, however old" (tests/legacy/admin.test.ts).
  it('keeps a trashed photo while any kept copy refers to it, and restoring that copy brings it back', async () => {
    const store = tempStore();
    const files = new PhotoFiles(store.dataDir);
    const photos = new FilePhotoStore(files);
    const copies = new FileKeptCopies(store.backupDir, store.file);
    const ledger = new StoreWholeLedger(store);
    let now = new Date();
    const log = { info: () => undefined, warn: () => undefined };
    const deps = { photos, ledgerPhotos: ledger, copies, ledger, clock: { now: () => now }, log, settings: { retention: () => DEFAULT_RETENTION, setRetention: () => undefined, lastFullBackupAt: () => null, noteFullBackup: () => undefined } };
    const housekeeping = new Housekeeping({ ...deps, prune: new PruneCopies(deps) });
    const kept = files.put(JPEG)?.id ?? '';
    const loose = files.put(JPEG)?.id ?? '';
    // An old monthly copy has a card with the first photo; nothing refers to the second.
    fs.writeFileSync(path.join(store.backupDir, 'db-2025-01-31.json'), JSON.stringify({ cards: { c1: { name: 'Lapras', imageId: kept } } }));
    files.remove(kept);
    files.remove(loose);
    now = new Date(Date.now() + 500 * 86_400_000);
    assert.equal((await housekeeping.execute()).photosPurged, 1);
    assert.equal(files.untrash(loose), false);
    // Restoring that copy brings its photo back.
    assert.deepEqual(await new RestoreCopy(deps).execute({ actor: 'admin', name: 'db-2025-01-31.json' }), { ok: true, value: { cards: 1, photosRecovered: 1 } });
    assert.ok(files.find(kept));
    assert.equal(store.get('cards', 'c1')?.['imageId'], kept);
  });
});
