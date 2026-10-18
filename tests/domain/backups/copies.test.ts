import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { beforeRestoreName, copiesToDrop, dailyCopyName, describeCopy, isCopyName, type KeptCopy, MAX_BEFORE_RESTORE, MAX_SNAPSHOTS, newestFirst, snapshotName } from '#domain/backups/copies.ts';

const at = new Date('2026-10-18T12:34:56.789Z');

describe('kept copies', () => {
  it('are named for their kind and when they were taken', () => {
    assert.equal(dailyCopyName('2026-10-18'), 'db-2026-10-18.json');
    assert.equal(beforeRestoreName(at), 'db-before-restore-2026-10-18T12-34-56-789Z.json');
    assert.equal(snapshotName(at, 'Before cleanup!'), 'db-snapshot-2026-10-18T12-34-56-789Z-before-cleanup.json');
    assert.equal(snapshotName(at, undefined), 'db-snapshot-2026-10-18T12-34-56-789Z.json');
    assert.equal(snapshotName(at, '!!!'), 'db-snapshot-2026-10-18T12-34-56-789Z.json');
  });

  it('only names like those are copies, so nothing outside the folder is reached', () => {
    for (const name of ['db-2026-10-18.json', 'db-snapshot-x.json', 'db-before-restore-x.json']) assert.equal(isCopyName(name), true, name);
    for (const name of ['../auth.json', 'db-2026-10-18.json.tmp', 'auth.json', 'db-snapshot-../x.json']) assert.equal(isCopyName(name), false, name);
  });

  it('describe themselves: kind, when, size and a snapshot’s label', () => {
    const modified = new Date('2026-10-18T13:00:00.000Z');
    assert.deepEqual(describeCopy('db-2026-10-17.json', modified, 10), { name: 'db-2026-10-17.json', kind: 'daily', at: '2026-10-17T00:00:00.000Z', bytes: 10 });
    assert.deepEqual(describeCopy(snapshotName(at, 'Before cleanup'), modified, 5), { name: 'db-snapshot-2026-10-18T12-34-56-789Z-before-cleanup.json', kind: 'snapshot', at: modified.toISOString(), bytes: 5, label: 'before cleanup' });
    assert.deepEqual(describeCopy(beforeRestoreName(at), modified, 1)?.kind, 'before-restore');
    assert.equal(describeCopy('notes.txt', modified, 1), null);
  });

  it('drop past retention: daily copies retention no longer keeps, and old snapshots and before-restore copies past their counts', () => {
    const copy = (name: string, isoAt: string): KeptCopy => {
      const c = describeCopy(name, new Date(isoAt), 1);
      assert.ok(c);
      return c;
    };
    const daily = ['2026-01-05', '2026-01-06', '2026-02-10', '2026-09-30', '2026-10-03'].map((d) => copy(dailyCopyName(d), d));
    const snaps = Array.from({ length: MAX_SNAPSHOTS + 2 }, (_, i) => copy(snapshotName(new Date(Date.UTC(2026, 0, 1, 0, i)), `s${i}`), new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
    const restores = Array.from({ length: MAX_BEFORE_RESTORE + 1 }, (_, i) => copy(beforeRestoreName(new Date(Date.UTC(2026, 1, 1, 0, i))), new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString()));
    const drop = copiesToDrop([...daily, ...snaps, ...restores], { daily: 2, weekly: 0, monthly: 0 });
    assert.deepEqual(drop.filter((c) => c.kind === 'daily').map((c) => c.name).sort(), ['db-2026-01-05.json', 'db-2026-01-06.json', 'db-2026-02-10.json']);
    assert.deepEqual(drop.filter((c) => c.kind === 'snapshot').map((c) => c.label), ['s1', 's0']);
    assert.deepEqual(drop.filter((c) => c.kind === 'before-restore').length, 1);
    assert.equal(newestFirst(daily)[0]?.name, 'db-2026-10-03.json');
  });
});
