import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPhoto, isPhotoId, photoType } from '#domain/photos/photo.ts';
import { photosReferencedBy } from '#domain/photos/references.ts';
import { anyOldEnough, purgeable, TRASH_DAYS } from '#domain/photos/trash.ts';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3);

describe('photos', () => {
  it('know their type from their first bytes, not what the browser claimed', () => {
    assert.equal(photoType(JPEG), 'image/jpeg');
    assert.equal(photoType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png');
    assert.equal(photoType(text('GIF89a...')), 'image/gif');
    assert.equal(photoType(text('GIF87a...')), 'image/gif');
    assert.equal(photoType(text('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.equal(photoType(text('<svg onload=alert(1)>')), null);
    assert.equal(photoType(bytes(0xff, 0xd8)), null);
  });

  it('must have bytes and be a picture', () => {
    assert.deepEqual(checkPhoto(JPEG), { ok: true, value: 'image/jpeg' });
    assert.deepEqual(checkPhoto(bytes()), { ok: false, error: { code: 'PHOTO_EMPTY' } });
    assert.deepEqual(checkPhoto(text('hello')), { ok: false, error: { code: 'NOT_A_PICTURE' } });
  });

  it('have 32-hex-character ids', () => {
    assert.equal(isPhotoId('a'.repeat(32)), true);
    assert.equal(isPhotoId('A'.repeat(32)), false);
    assert.equal(isPhotoId('../db.json'), false);
  });

  it('a ledger refers to its cards’ own photos and official pictures, not inline data: URLs', () => {
    const ledger = { cards: { a: { imageId: 'p1', officialImageId: 'o1' }, b: { imageId: 'data:image/png;base64,AAAA' }, c: 'junk' } };
    assert.deepEqual([...photosReferencedBy(ledger)].sort(), ['o1', 'p1']);
    assert.deepEqual([...photosReferencedBy({ cards: 'none' })], []);
    assert.deepEqual([...photosReferencedBy(null)], []);
  });
});

describe('the photo trash', () => {
  const day = 86_400_000;
  const now = new Date('2026-10-18T00:00:00Z');
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * day);
  const trashed = [
    { id: 'old', name: 'old.jpg', trashedAt: at(TRASH_DAYS + 1) },
    { id: 'kept', name: 'kept.jpg', trashedAt: at(TRASH_DAYS + 100) },
    { id: 'recent', name: 'recent.jpg', trashedAt: at(TRASH_DAYS - 1) },
  ];

  it('deletes a photo only once it is old enough and nothing refers to it, however old', () => {
    assert.deepEqual(purgeable(trashed, now, new Set(['kept'])).map((p) => p.id), ['old']);
    assert.deepEqual(purgeable(trashed, now, new Set(['kept', 'old'])), []);
  });

  it('says whether anything is old enough before anyone reads the kept copies', () => {
    assert.equal(anyOldEnough(trashed, now), true);
    assert.equal(anyOldEnough(trashed.filter((p) => p.id === 'recent'), now), false);
  });
});
