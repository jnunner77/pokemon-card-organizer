import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { PhotoId } from '#domain/photos/photo.ts';
import { FilePhotoStore } from '#infrastructure/photos/file-photo-store.ts';
import { PhotoFiles } from '#infrastructure/photos/photo-files.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);

function tempFiles(): PhotoFiles {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-photos-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new PhotoFiles(dir);
}

describe('PhotoFiles', () => {
  it('stores pictures under random ids with their own extension, and finds them', () => {
    const files = tempFiles();
    const jpeg = files.put(JPEG);
    assert.ok(jpeg);
    assert.match(jpeg.id, /^[a-f0-9]{32}$/);
    assert.equal(jpeg.type, 'image/jpeg');
    assert.equal(path.basename(files.find(jpeg.id)?.file ?? ''), `${jpeg.id}.jpg`);
    assert.equal(files.put(Buffer.from('<svg>')), null);
    assert.equal(files.put(JPEG, '../escape'), null);
    assert.equal(files.find('../db.json'), null);
  });

  it('trashes, brings back and purges photos', () => {
    const files = tempFiles();
    const id = files.put(PNG)?.id ?? '';
    assert.equal(files.remove(id), true);
    assert.equal(files.find(id), null);
    assert.deepEqual(files.trashed().map((p) => p.id), [id]);
    assert.equal(files.untrash(id), true);
    assert.ok(files.find(id));
    files.remove(id);
    const [trashed] = files.trashed();
    assert.ok(trashed);
    files.purge(trashed.name);
    assert.deepEqual(files.trashed(), []);
    assert.equal(files.untrash(id), false);
  });

  it('replacing a photo under the same id trashes the old one first', () => {
    const files = tempFiles();
    const id = files.put(JPEG)?.id ?? '';
    files.put(PNG, id);
    assert.equal(files.find(id)?.type, 'image/png');
    assert.equal(files.trashed().length, 1);
    assert.deepEqual(files.usage(), { photos: 1, bytes: PNG.length, trashed: 1 });
  });
});

describe('FilePhotoStore', () => {
  it('serves the photo store port over the files', async () => {
    const files = tempFiles();
    const store = new FilePhotoStore(files);
    const id = 'b'.repeat(32) as PhotoId;
    await store.save(id, JPEG);
    assert.equal(await store.has(id), true);
    assert.deepEqual(await store.list(), [id]);
    assert.deepEqual((await store.read(id))?.bytes, JPEG);
    const opened = await store.open(id);
    assert.ok(opened);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.content) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), JPEG);
    assert.equal(opened.bytes, JPEG.length);
    assert.equal(await store.trash(id), true);
    assert.equal(await store.open(id), null);
    const [trashed] = await store.trashed();
    assert.ok(trashed);
    await store.purge(trashed);
    assert.deepEqual(await store.usage(), { photos: 0, bytes: 0, trashed: 0 });
  });
});
