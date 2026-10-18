import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DownloadFullBackup } from '#application/backups/download-full-backup.ts';
import { RestoreFullBackup } from '#application/backups/restore-full-backup.ts';
import type { PhotoId } from '#domain/photos/photo.ts';
import { JPEG, PNG, photoId, setUp } from './fixtures.ts';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('full backups', () => {
  it('download everything with every photo, note when, and restore on another server', async () => {
    const a = setUp();
    const id = photoId(1) as PhotoId;
    await a.photos.save(id, 'image/jpeg', JPEG);
    a.ledger.data = { binders: { b1: { name: 'IR' } }, cards: { c1: { name: 'Mew', imageId: id } }, settings: { main: { usdToCad: 1.4 } } };
    const { filename, backup } = await new DownloadFullBackup(a.deps).execute({ actor: 'justin' });
    assert.equal(filename, 'binder-ledger-backup-2026-10-18.json');
    assert.deepEqual(backup.assets, { [id]: { type: 'image/jpeg', data: b64(JPEG) } });
    assert.equal(a.settings.lastFullBackupAt(), '2026-10-18T12:00:00.000Z');
    assert.deepEqual(a.logged, ['justin downloaded a full backup']);

    const b = setUp();
    b.ledger.data = { binders: {}, cards: { old: { name: 'Lapras' } }, settings: {} };
    const r = await new RestoreFullBackup(b.deps).execute({ actor: 'admin', backup: JSON.parse(JSON.stringify(backup)) });
    assert.deepEqual(r, { ok: true, value: { binders: 1, cards: 1, photos: 1, missingPhotos: 0 } });
    assert.deepEqual(b.ledger.data, a.ledger.data);
    assert.deepEqual((await b.photos.read(id))?.bytes, JPEG);
    assert.ok((await b.copies.list()).some((c) => c.kind === 'before-restore'));
    assert.deepEqual(b.logged, ['warn: admin restored a full backup']);
  });

  it('counts cards whose photo is in neither the backup nor this server', async () => {
    const { deps } = setUp();
    const backup = { format: 'pokemon-binder-ledger-backup', version: 1, binders: {}, cards: { c1: { imageId: photoId(9) }, c2: { imageId: 'data:image/png;base64,AA' } }, settings: {} };
    assert.deepEqual(await new RestoreFullBackup(deps).execute({ actor: 'admin', backup }), { ok: true, value: { binders: 0, cards: 2, photos: 0, missingPhotos: 1 } });
  });

  it('changes nothing when anything in the backup is wrong: a document, an empty photo, a file that is not a picture', async () => {
    const { deps, ledger, photos } = setUp();
    ledger.data = { binders: {}, cards: { old: { name: 'Lapras' } }, settings: {} };
    const restore = new RestoreFullBackup(deps);
    const base = { format: 'pokemon-binder-ledger-backup', version: 1, binders: {}, cards: {}, settings: {} };
    const message = async (backup: unknown) => {
      const r = await restore.execute({ actor: 'admin', backup });
      assert.ok(!r.ok);
      return r.error.message;
    };
    assert.match(await message({ ...base, cards: { c1: { slot: -3 } } }), /^cards\.c1/);
    assert.equal(await message({ hello: 'world' }), "format: That file isn't a Pokémon Binder Ledger backup");
    // Empty photos are reported before ones that aren't pictures, and nothing is stored either way.
    const assets = { [photoId(1)]: { type: 'image/png', data: b64(PNG) }, [photoId(2)]: { type: 'image/jpeg', data: b64(new TextEncoder().encode('nope')) }, [photoId(3)]: { type: 'image/jpeg', data: '' } };
    assert.equal(await message({ ...base, assets }), `assets.${photoId(3)}: the photo is empty`);
    assert.equal(await message({ ...base, assets: { [photoId(1)]: assets[photoId(1)], [photoId(2)]: assets[photoId(2)] } }), `assets.${photoId(2)}: that isn't a JPG, PNG, WebP or GIF picture`);
    assert.equal(photos.stored.size, 0);
    assert.deepEqual(Object.keys(ledger.data.cards), ['old']);
    assert.equal(ledger.resets, 0);
  });
});
