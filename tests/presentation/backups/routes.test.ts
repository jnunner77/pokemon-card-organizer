import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Caller } from '#application/access.ts';
import { err, ok } from '#shared/result.ts';
import { backupRoutes, type BackupRouteDeps } from '#presentation/backups/routes.ts';
import { json, serve } from '../fixtures.ts';

const unused = { execute: async () => assert.fail('not expected to run') };
const copy = { name: 'db-snapshot-x-before-cleanup.json', kind: 'snapshot' as const, at: '2026-10-18T12:00:00.000Z', bytes: 2, label: 'before cleanup' };

async function setUp(over: Partial<BackupRouteDeps> = {}) {
  const asked: unknown[] = [];
  const record = <T>(answer: T) => ({ execute: async (input?: unknown) => (asked.push(input), answer) });
  const deps: BackupRouteDeps = {
    identify: (req) => {
      const role = req.headers['x-role'];
      return role === 'viewer' || role === 'editor' || role === 'admin' ? ({ name: 'justin', role } satisfies Caller) : null;
    },
    downloadFullBackup: record({ filename: 'binder-ledger-backup-2026-10-18.json', backup: { format: 'pokemon-binder-ledger-backup' } as never }),
    restoreFullBackup: record(err({ code: 'INVALID_BACKUP' as const, message: "format: That file isn't a Pokémon Binder Ledger backup" })),
    listCopies: record({ backups: [copy], retention: { daily: 14, weekly: 8, monthly: 12 }, lastFullBackupAt: null, photos: { photos: 0, bytes: 0, trashed: 0 } }),
    changeRetention: record(ok({ retention: { daily: 1, weekly: 0, monthly: 0 }, removed: 2 })),
    takeSnapshot: record(copy),
    downloadCopy: record(ok({ name: copy.name, text: '{"cards":{}}' })),
    restoreCopy: record(err({ code: 'COPY_NOT_FOUND' as const })),
    deleteCopy: record(ok(undefined)),
    ...over,
  };
  const routes = backupRoutes(deps);
  return { base: await serve(routes.handle), asked, routes };
}
const as = (role: string, init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers);
  headers.set('X-Role', role);
  return { ...init, headers };
};

describe('backup routes', () => {
  it('download a full backup as a file, for editors', async () => {
    const { base, asked } = await setUp();
    const r = await fetch(`${base}/backup`, as('editor'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="binder-ledger-backup-2026-10-18.json"');
    assert.deepEqual(await r.json(), { format: 'pokemon-binder-ledger-backup' });
    assert.deepEqual(asked, [{ actor: 'justin' }]);
    assert.equal((await fetch(`${base}/backup`, as('viewer'))).status, 403);
  });

  it('restore only for administrators, checked before the upload is read', async () => {
    const { base, asked } = await setUp();
    const editor = await fetch(`${base}/restore`, as('editor', json({})));
    assert.deepEqual([editor.status, await editor.json()], [403, { error: 'Only administrators can do this.', code: 'forbidden' }]);
    assert.deepEqual(asked, []);
    const bad = await fetch(`${base}/restore`, as('admin', json({ hello: 'world' })));
    assert.deepEqual([bad.status, await bad.json()], [400, { error: "format: That file isn't a Pokémon Binder Ledger backup", code: 'invalid_argument' }]);
    assert.deepEqual(asked, [{ actor: 'justin', backup: { hello: 'world' } }]);
  });

  it('list, snapshot, download, restore and delete kept copies, for administrators', async () => {
    const { base, asked } = await setUp();
    assert.equal((await fetch(`${base}/admin/backups`, as('editor'))).status, 403);
    assert.deepEqual(await (await fetch(`${base}/admin/backups`, as('admin'))).json(), { backups: [copy], retention: { daily: 14, weekly: 8, monthly: 12 }, lastFullBackupAt: null, photos: { photos: 0, bytes: 0, trashed: 0 } });
    const snap = await fetch(`${base}/admin/backups/snapshot`, as('admin', json({ label: 'x'.repeat(50) })));
    assert.deepEqual([snap.status, await snap.json()], [201, copy]);
    assert.deepEqual(asked.at(-1), { actor: 'justin', label: 'x'.repeat(40) });
    const file = await fetch(`${base}/admin/backups/${copy.name}`, as('admin'));
    assert.deepEqual([file.status, file.headers.get('content-type'), file.headers.get('content-disposition'), await file.text()], [200, 'application/json; charset=utf-8', `attachment; filename="${copy.name}"`, '{"cards":{}}']);
    const restore = await fetch(`${base}/admin/backups/${copy.name}/restore`, as('admin', { method: 'POST' }));
    assert.deepEqual([restore.status, await restore.json()], [404, { error: 'No such backup', code: 'not_found' }]);
    assert.equal((await fetch(`${base}/admin/backups/${copy.name}`, as('admin', { method: 'DELETE' }))).status, 204);
  });

  it('change retention', async () => {
    const { base } = await setUp();
    const r = await fetch(`${base}/admin/backups/retention`, as('admin', json({ daily: 1, weekly: 0, monthly: 0 }, 'PUT')));
    assert.deepEqual([r.status, await r.json()], [200, { retention: { daily: 1, weekly: 0, monthly: 0 }, removed: 2 }]);
    const refused = await setUp({ changeRetention: { execute: async () => err({ code: 'INVALID_RETENTION' as const, message: 'daily: Too small: at least 1' }) } });
    const bad = await fetch(`${refused.base}/admin/backups/retention`, as('admin', json({ daily: 0 }, 'PUT')));
    assert.deepEqual([bad.status, await bad.json()], [400, { error: 'daily: Too small: at least 1', code: 'invalid_argument' }]);
  });

  it('mark backups, restores and copy downloads as heavy, for the stricter rate limit', async () => {
    const { routes } = await setUp({ listCopies: unused });
    assert.equal(routes.isHeavy('GET', '/backup'), true);
    assert.equal(routes.isHeavy('POST', '/restore'), true);
    assert.equal(routes.isHeavy('POST', '/admin/backups/snapshot'), true);
    assert.equal(routes.isHeavy('GET', '/admin/backups/db-2026-10-18.json'), true);
    assert.equal(routes.isHeavy('POST', '/admin/backups/db-2026-10-18.json/restore'), true);
    assert.equal(routes.isHeavy('GET', '/admin/backups'), false);
    assert.equal(routes.isHeavy('DELETE', '/admin/backups/db-2026-10-18.json'), false);
  });
});
