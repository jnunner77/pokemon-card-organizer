import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BackupHealth } from '#application/backups/backup-health.ts';
import { ChangeRetention } from '#application/backups/change-retention.ts';
import { DeleteCopy } from '#application/backups/delete-copy.ts';
import { DownloadCopy } from '#application/backups/download-copy.ts';
import { ListCopies } from '#application/backups/list-copies.ts';
import { RestoreCopy } from '#application/backups/restore-copy.ts';
import { TakeSnapshot } from '#application/backups/take-snapshot.ts';
import type { PhotoId } from '#domain/photos/photo.ts';
import { JPEG, photoId, setUp } from './fixtures.ts';

describe('snapshots', () => {
  it('copy the ledger as it is now under the label, and are listed', async () => {
    const { deps, ledger, prune, logged } = setUp();
    ledger.data = { binders: {}, cards: { c1: { name: 'Mew' } }, settings: {} };
    const snap = await new TakeSnapshot({ ...deps, prune }).execute({ actor: 'admin', label: 'Before cleanup' });
    assert.deepEqual({ kind: snap.kind, label: snap.label }, { kind: 'snapshot', label: 'before cleanup' });
    assert.deepEqual(JSON.parse((await deps.copies.read(snap.name)) ?? ''), ledger.data);
    assert.deepEqual(logged, ['admin took a snapshot "Before cleanup"']);
    const list = await new ListCopies(deps).execute();
    assert.deepEqual(list.backups.map((c) => c.name), [snap.name]);
    assert.deepEqual(list.photos, { photos: 0, bytes: 0, trashed: 0 });
  });
});

describe('restoring a kept copy', () => {
  // The restore half of "keeps a trashed photo while any kept copy refers to it" (tests/legacy/admin.test.ts).
  it('puts it back as the ledger, keeps the current one first, and brings back the photos it needs', async () => {
    const { deps, photos, ledger, copies, logged } = setUp();
    const kept = photoId(1) as PhotoId;
    await photos.save(kept, 'image/jpeg', JPEG);
    await photos.trash(kept);
    copies.files.set('db-2025-01-31.json', { text: JSON.stringify({ cards: { c1: { name: 'Mew', imageId: kept } } }), at: new Date(0) });
    ledger.data = { binders: {}, cards: { now: { name: 'Lapras' } }, settings: {} };
    const r = await new RestoreCopy(deps).execute({ actor: 'admin', name: 'db-2025-01-31.json' });
    assert.deepEqual(r, { ok: true, value: { cards: 1, photosRecovered: 1 } });
    assert.equal(await photos.has(kept), true);
    assert.deepEqual(Object.keys(ledger.data.cards), ['c1']);
    assert.equal(ledger.resets, 1);
    assert.ok((await copies.list()).some((c) => c.kind === 'before-restore'));
    assert.deepEqual(logged, ['warn: admin restored the ledger from db-2025-01-31.json']);
  });

  it('refuses a copy that is not there, or a name that is not a copy, changing nothing', async () => {
    const { deps, ledger } = setUp();
    const restore = new RestoreCopy(deps);
    assert.deepEqual(await restore.execute({ actor: 'admin', name: 'db-2020-01-01.json' }), { ok: false, error: { code: 'COPY_NOT_FOUND' } });
    assert.deepEqual(await restore.execute({ actor: 'admin', name: '../auth.json' }), { ok: false, error: { code: 'COPY_NOT_FOUND' } });
    assert.equal(ledger.resets, 0);
  });
});

describe('downloading and deleting copies', () => {
  it('downloads and deletes a copy by name; others are not found', async () => {
    const { deps, copies, logged } = setUp();
    copies.files.set('db-2026-10-17.json', { text: '{"cards":{}}', at: new Date(0) });
    assert.deepEqual(await new DownloadCopy(deps).execute({ name: 'db-2026-10-17.json' }), { ok: true, value: { name: 'db-2026-10-17.json', text: '{"cards":{}}' } });
    assert.deepEqual(await new DownloadCopy(deps).execute({ name: '..%2Fauth.json' }), { ok: false, error: { code: 'COPY_NOT_FOUND' } });
    assert.deepEqual(await new DeleteCopy(deps).execute({ actor: 'admin', name: 'db-2026-10-17.json' }), { ok: true, value: undefined });
    assert.deepEqual(await new DeleteCopy(deps).execute({ actor: 'admin', name: 'db-2026-10-17.json' }), { ok: false, error: { code: 'COPY_NOT_FOUND' } });
    assert.deepEqual(logged, ['admin deleted the copy db-2026-10-17.json']);
  });
});

describe('retention', () => {
  it('is changed and applied at once, and refused when out of range', async () => {
    const { deps, copies, settings, prune, logged } = setUp();
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) copies.files.set(`db-${d}.json`, { text: '{}', at: new Date(0) });
    const change = new ChangeRetention({ ...deps, prune });
    assert.deepEqual(await change.execute({ actor: 'admin', retention: { daily: 1, weekly: 0, monthly: 0 } }), { ok: true, value: { retention: { daily: 1, weekly: 0, monthly: 0 }, removed: 2 } });
    assert.deepEqual([...copies.files.keys()], ['db-2026-10-03.json']);
    assert.deepEqual(settings.retention(), { daily: 1, weekly: 0, monthly: 0 });
    assert.deepEqual(await change.execute({ actor: 'admin', retention: { daily: 0, weekly: 0, monthly: 0 } }), { ok: false, error: { code: 'INVALID_RETENTION', message: 'daily: Too small: at least 1' } });
    assert.deepEqual(logged, ['Removed 2 old copies of the ledger', 'admin changed backup retention']);
  });
});

describe('backup health', () => {
  it('reports the newest daily copy and what is kept', async () => {
    const { deps, copies } = setUp();
    copies.files.set('db-2026-10-16.json', { text: '{}', at: new Date(0) });
    copies.files.set('db-2026-10-17.json', { text: '{"a":1}', at: new Date(0) });
    copies.files.set('db-snapshot-x.json', { text: '{}', at: new Date('2026-10-01') });
    assert.deepEqual(await new BackupHealth(deps).execute(), { newestDaily: '2026-10-17T00:00:00.000Z', dailyCopies: 2, snapshots: 1, bytes: 11, retention: { daily: 14, weekly: 8, monthly: 12 } });
  });
});
