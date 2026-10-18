import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Housekeeping } from '#application/backups/housekeeping.ts';
import type { PhotoId } from '#domain/photos/photo.ts';
import { JPEG, photoId, setUp } from './fixtures.ts';

const DAY = 86_400_000;

describe('Housekeeping', () => {
  // Moved from "takes the daily copy and applies retention" (tests/legacy/admin.test.ts).
  it('takes the daily copy and applies retention', async () => {
    const { deps, copies, settings, prune, logged, setNow } = setUp();
    copies.ledgerFile = '{"cards":{}}';
    for (const d of ['2026-01-05', '2026-01-06', '2026-02-10', '2026-09-30']) copies.files.set(`db-${d}.json`, { text: '{}', at: new Date(0) });
    settings.setRetention({ daily: 2, weekly: 0, monthly: 0 });
    setNow(new Date('2026-10-03T08:00:00.000Z'));
    assert.deepEqual(await new Housekeeping({ ...deps, prune }).execute(), { dailyCopy: true, photosPurged: 0 });
    const daily = (await copies.list()).filter((c) => c.kind === 'daily').map((c) => c.name).sort().reverse();
    assert.deepEqual(daily, ['db-2026-10-03.json', 'db-2026-09-30.json']);
    assert.equal(logged[0], 'Took the daily copy for 2026-10-03');
  });

  it('takes no daily copy before there is a ledger file, nor a second one the same day', async () => {
    const { deps, copies, prune } = setUp();
    const housekeeping = new Housekeeping({ ...deps, prune });
    assert.equal((await housekeeping.execute()).dailyCopy, false);
    copies.ledgerFile = '{}';
    assert.equal((await housekeeping.execute()).dailyCopy, true);
    assert.equal((await housekeeping.execute()).dailyCopy, false);
  });

  // Moved from "keeps a trashed photo while any kept copy refers to it, however old" (tests/legacy/admin.test.ts).
  it('keeps a trashed photo while the ledger or any kept copy refers to it, however old', async () => {
    const { deps, photos, copies, ledger, prune, logged, setNow } = setUp();
    const [kept, loose] = [photoId(1) as PhotoId, photoId(2) as PhotoId];
    await photos.save(kept, 'image/jpeg', JPEG);
    await photos.save(loose, 'image/jpeg', JPEG);
    // An old monthly copy has a card with the first photo; nothing refers to the second.
    copies.files.set('db-2025-01-31.json', { text: JSON.stringify({ cards: { c1: { imageId: kept } } }), at: new Date(0) });
    await photos.trash(kept);
    await photos.trash(loose);
    setNow(new Date(Date.parse('2026-10-18T12:00:00.000Z') + 500 * DAY));
    const housekeeping = new Housekeeping({ ...deps, prune });
    assert.equal((await housekeeping.execute()).photosPurged, 1);
    assert.equal(await photos.untrash(loose), false);
    assert.ok(logged.includes('Deleted 1 trashed photo that no kept copy of the ledger refers to'));
    // With no copies left, the ledger's own card still keeps it.
    copies.files.clear();
    ledger.data = { binders: {}, cards: { c1: { imageId: kept } }, settings: {} };
    assert.equal((await housekeeping.execute()).photosPurged, 0);
    // A copy that can't be read keeps them all.
    ledger.data = { binders: {}, cards: {}, settings: {} };
    copies.files.clear();
    copies.files.set('db-2025-01-31.json', { text: '{not json', at: new Date(1) });
    assert.equal((await housekeeping.execute()).photosPurged, 0);
    assert.ok(logged.some((m) => m.startsWith("warn: Couldn't read the copy db-2025-01-31.json")));
    // Once nothing refers to it, an old trashed photo goes.
    copies.files.clear();
    assert.equal((await housekeeping.execute()).photosPurged, 1);
  });

  it('deletes nothing younger than the trash keeps', async () => {
    const { deps, photos, prune } = setUp();
    await photos.save(photoId(3) as PhotoId, 'image/jpeg', JPEG);
    await photos.trash(photoId(3) as PhotoId);
    assert.equal((await new Housekeeping({ ...deps, prune }).execute()).photosPurged, 0);
  });
});
