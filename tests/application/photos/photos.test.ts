import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeletePhoto } from '#application/photos/delete-photo.ts';
import { OpenPhoto } from '#application/photos/open-photo.ts';
import { UploadPhoto } from '#application/photos/upload-photo.ts';
import type { PhotoId } from '#domain/photos/photo.ts';
import { MemoryLedgerPhotos, MemoryPhotoStore } from '#infrastructure/memory/photos.ts';
import { JPEG, photoId } from '../backups/fixtures.ts';

const ids = (...list: string[]) => ({ next: () => list.shift() ?? 'none' });

describe('UploadPhoto', () => {
  it('stores a picture under a new id', async () => {
    const photos = new MemoryPhotoStore();
    const r = await new UploadPhoto({ photos, ids: ids(photoId(1)) }).execute({ bytes: JPEG });
    assert.deepEqual(r, { ok: true, value: { id: photoId(1), type: 'image/jpeg' } });
    assert.deepEqual((await photos.read(photoId(1) as PhotoId))?.bytes, JPEG);
  });

  it('refuses nothing at all, or what is not a picture, storing nothing', async () => {
    const photos = new MemoryPhotoStore();
    const upload = new UploadPhoto({ photos, ids: ids(photoId(1), photoId(2)) });
    assert.deepEqual(await upload.execute({ bytes: new Uint8Array() }), { ok: false, error: { code: 'PHOTO_EMPTY' } });
    assert.deepEqual(await upload.execute({ bytes: new TextEncoder().encode('<svg onload=alert(1)>') }), { ok: false, error: { code: 'NOT_A_PICTURE' } });
    assert.equal(photos.stored.size, 0);
  });
});

describe('DeletePhoto', () => {
  it('moves a photo to the trash, but never one a card still shows', async () => {
    const photos = new MemoryPhotoStore();
    const ledgerPhotos = new MemoryLedgerPhotos();
    const [loose, shown] = [photoId(1) as PhotoId, photoId(2) as PhotoId];
    await photos.save(loose, JPEG);
    await photos.save(shown, JPEG);
    ledgerPhotos.ids.add(shown);
    const del = new DeletePhoto({ photos, ledgerPhotos });
    await del.execute({ id: loose });
    await del.execute({ id: shown });
    await del.execute({ id: '../db.json' });
    assert.deepEqual([await photos.has(loose), await photos.has(shown)], [false, true]);
    assert.deepEqual([...photos.trashBin.keys()], [loose]);
  });
});

describe('OpenPhoto', () => {
  it('opens a stored photo, and nothing for an unknown or malformed id', async () => {
    const photos = new MemoryPhotoStore();
    await photos.save(photoId(1) as PhotoId, JPEG);
    const open = new OpenPhoto({ photos });
    const file = await open.execute({ id: photoId(1) });
    assert.equal(file?.type, 'image/jpeg');
    assert.equal(file?.bytes, JPEG.length);
    assert.equal(await open.execute({ id: photoId(2) }), null);
    assert.equal(await open.execute({ id: '../db.json' }), null);
  });
});
