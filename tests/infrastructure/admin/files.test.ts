import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { AdminFile } from '#infrastructure/admin/admin-file.ts';
import { FileSecret } from '#infrastructure/admin/file-secret.ts';
import { NodeDiskUsage, NodeRuntime } from '#infrastructure/admin/node-server.ts';
import { FileOffsiteRecord, FileStatusFile } from '#infrastructure/admin/status-files.ts';
import { StorePriceUpdateRecord } from '#infrastructure/json-store/price-update-record.ts';
import { tempStore } from '../json-store/fixtures.ts';

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-admin-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe('AdminFile', () => {
  it('starts from the defaults, saves changes to admin.json readable only by the server, and reads them back', () => {
    const dir = tempDir();
    const a = new AdminFile(dir, { pricing: { enabled: false, hour: 6 } });
    assert.deepEqual(a.get().pricing, { enabled: false, hour: 6 });
    assert.equal(a.recovered, null);
    a.set({ pricing: { enabled: true, hour: 7, cardmarket: false }, lastFullBackupAt: '2026-10-03T12:00:00.000Z' });
    assert.equal(mode(path.join(dir, 'admin.json')), 0o600);
    const again = new AdminFile(dir);
    assert.deepEqual(again.get().pricing, { enabled: true, hour: 7, cardmarket: false });
    assert.equal(again.get().lastFullBackupAt, '2026-10-03T12:00:00.000Z');
    assert.deepEqual(again.get().backups, { daily: 14, weekly: 8, monthly: 12 });
  });

  it('sets a damaged admin.json aside and uses the defaults', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'admin.json'), '{"pricing": {"hour": 7');
    const a = new AdminFile(dir);
    assert.deepEqual(a.get().pricing, { enabled: true, hour: 5, cardmarket: true });
    assert.match(a.recovered ?? '', /^admin\.json was damaged .*The default settings are used/);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('admin.json.damaged-')).length, 1);
  });
});

describe('FileSecret', () => {
  it('keeps the token in its own file (0600), and tells only whether one is saved and when', () => {
    const dir = path.join(tempDir(), 'secrets');
    const s = new FileSecret(dir, 'pricecharting-token');
    assert.deepEqual([s.read(), s.info()], [null, { set: false, savedAt: null }]);
    s.write('  abc123  ');
    assert.equal(s.read(), 'abc123');
    assert.equal(mode(path.join(dir, 'pricecharting-token')), 0o600);
    assert.equal(s.info().set, true);
    assert.match(s.info().savedAt ?? '', /^\d{4}-\d\d-\d\dT/);
    s.clear();
    assert.deepEqual(s.info(), { set: false, savedAt: null });
  });
});

describe('status.txt and offsite.json', () => {
  it('writes the status file whole, and reads the nightly job’s record when it is one', async () => {
    const dir = tempDir();
    await new FileStatusFile(dir).write('written now\n');
    assert.equal(fs.readFileSync(path.join(dir, 'status.txt'), 'utf8'), 'written now\n');
    const offsite = new FileOffsiteRecord(dir);
    assert.equal(await offsite.latest(), null);
    fs.writeFileSync(path.join(dir, 'offsite.json'), JSON.stringify({ at: '2026-10-03T12:00:00.000Z', where: 'gs://b/x' }));
    assert.deepEqual(await offsite.latest(), { at: '2026-10-03T12:00:00.000Z', where: 'gs://b/x' });
    fs.writeFileSync(path.join(dir, 'offsite.json'), '{"at":"not a date"}');
    assert.equal(await offsite.latest(), null);
    fs.writeFileSync(path.join(dir, 'offsite.json'), '{"at"');
    assert.equal(await offsite.latest(), null);
  });
});

describe('the server and its disk', () => {
  it('counts what the data directory holds and the free space', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'photos'));
    fs.writeFileSync(path.join(dir, 'db.json'), 'x'.repeat(100));
    fs.writeFileSync(path.join(dir, 'photos', 'a.jpg'), 'y'.repeat(50));
    const disk = new NodeDiskUsage(dir);
    assert.equal(await disk.dataBytes(), 150);
    assert.ok(((await disk.freeBytes()) ?? 0) > 0);
    assert.equal(await new NodeDiskUsage(path.join(dir, 'missing')).dataBytes(), 0);
    const info = new NodeRuntime().info();
    assert.equal(info.node, process.version);
    assert.ok(info.startedAt.getTime() <= Date.now());
  });
});

describe('StorePriceUpdateRecord', () => {
  it('reads the daily update’s saved state and the exchange rate’s date from the ledger’s settings', () => {
    const store = tempStore();
    const record = new StorePriceUpdateRecord(store);
    assert.deepEqual(record.summary(), { lastRun: null, running: false, problem: null, rateDate: null });
    store.set('settings', 'pricing', { running: true, lastRun: { date: '2026-10-03', finishedAt: '2026-10-03T06:00:00.000Z', counts: { updated: 2, odd: 'x' } }, problem: { title: 'Stalled', message: 'No progress.', recoveredAt: null } });
    store.set('settings', 'main', { usdToCadDate: '2026-10-02' });
    assert.deepEqual(record.summary(), { lastRun: { date: '2026-10-03', finishedAt: '2026-10-03T06:00:00.000Z', counts: { updated: 2 } }, running: true, problem: { title: 'Stalled', message: 'No progress.', recoveredAt: null }, rateDate: '2026-10-02' });
    assert.equal(record.saved()['running'], true);
  });
});
