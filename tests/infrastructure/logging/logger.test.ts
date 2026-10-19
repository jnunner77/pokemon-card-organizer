import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { Logger } from '#infrastructure/logging/logger.ts';

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-logs-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe('Logger', () => {
  it('writes a file per day (0600) with secrets hidden, and keeps two weeks of them', async () => {
    const dir = tempDir();
    let now = new Date('2026-10-01T12:00:00.000Z');
    fs.writeFileSync(path.join(dir, '2026-09-01.jsonl'), '');
    const log = new Logger({ dir, stdout: false, now: () => now });
    log.info('auth', 'Signed in', { username: 'ash', password: 'pallet town' });
    assert.equal(log.fileOk, true);
    assert.deepEqual(log.files().map((f) => f.name), ['2026-10-01.jsonl']); // the old file was pruned
    const file = path.join(dir, '2026-10-01.jsonl');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('pallet town'));
    now = new Date('2026-10-02T12:00:00.000Z');
    log.warn('pricing', 'TCGdex timed out');
    assert.deepEqual(log.files().map((f) => f.name), ['2026-10-02.jsonl', '2026-10-01.jsonl']);
    const opened = await log.openFile('2026-10-01.jsonl');
    assert.ok(opened);
    assert.equal((await text(Readable.from(opened.content))).trim(), fs.readFileSync(file, 'utf8').trim());
    assert.equal(opened.bytes, fs.statSync(file).size);
    assert.equal(await log.openFile('../2026-10-01.jsonl'), null);
    assert.equal(await log.openFile('2026-01-01.jsonl'), null);
  });

  it('keeps the warnings and errors in the files across a restart, and finds a time range there', () => {
    const dir = tempDir();
    const now = () => new Date('2026-10-03T12:00:00.000Z');
    const log = new Logger({ dir, stdout: false, now });
    log.info('pricing', 'Price update started');
    log.error('app', 'The server crashed');
    fs.appendFileSync(path.join(dir, '2026-10-03.jsonl'), '{"cut short');
    const after = new Logger({ dir, stdout: false, now });
    assert.deepEqual(after.problems().map((e) => e.msg), ['The server crashed']);
    assert.deepEqual(after.problems('2026-10-03T12:00:00.000Z'), []);
    assert.deepEqual(after.between('2026-10-03T11:00:00.000Z', '2026-10-03T13:00:00.000Z', { cats: ['pricing'] }).map((e) => e.msg), ['Price update started']);
    assert.deepEqual(after.query(), []); // the recent list starts empty
  });

  it('searches recent entries by level, category, text and page, and counts them', () => {
    let now = new Date('2026-10-03T12:00:00.000Z');
    const log = new Logger({ stdout: false, now: () => now });
    log.info('http', 'GET /api/data 200');
    log.warn('auth', 'Failed sign-in for misty');
    const last = log.error('auth', 'Locked misty');
    assert.deepEqual(log.query({ level: 'warn' }).map((e) => e.msg), ['Locked misty', 'Failed sign-in for misty']);
    assert.deepEqual(log.query({ cat: 'auth', text: 'MISTY', before: last.id }).map((e) => e.msg), ['Failed sign-in for misty']);
    assert.deepEqual(log.query({ limit: 1 }).map((e) => e.msg), ['Locked misty']);
    assert.deepEqual(log.counts(60_000), { info: 1, warn: 1, error: 1 });
    now = new Date('2026-10-04T12:00:01.000Z');
    assert.deepEqual(log.counts(86_400_000), { info: 0, warn: 0, error: 0 });
    assert.deepEqual(log.files(), []);
    assert.equal(log.fileOk, null);
  });
});
