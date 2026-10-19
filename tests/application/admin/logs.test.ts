import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setUp } from './fixtures.ts';

describe('problems', () => {
  it('lists the warnings and errors since they were last seen, and marks them seen', () => {
    const a = setUp();
    a.log.warn('pricing', 'PriceCharting answered 500');
    a.log.info('pricing', 'Price update finished');
    a.setNow(new Date('2026-10-03T12:01:00.000Z'));
    a.log.error('backup', 'Housekeeping failed: ENOSPC');
    assert.deepEqual([a.listProblems.execute({ all: false }).errors, a.listProblems.execute({ all: false }).warnings], [1, 1]);
    const seen = a.markProblemsSeen.execute({ body: { upTo: '2026-10-03T12:00:30.000Z' } });
    assert.ok(seen.ok);
    assert.deepEqual([seen.value.seenAt, seen.value.errors, seen.value.warnings], ['2026-10-03T12:00:30.000Z', 1, 0]);
    assert.equal(a.settings.get().problemsSeenAt, '2026-10-03T12:00:30.000Z');
    assert.equal(a.listProblems.execute({ all: true }).warnings, 1);
    assert.deepEqual(a.markProblemsSeen.execute({ body: undefined }), { ok: true, value: { seenAt: '2026-10-03T12:01:00.000Z', errors: 0, warnings: 0, groups: [], latest: null } });
    assert.equal(a.markProblemsSeen.execute({ body: { upTo: 'yesterday' } }).ok, false);
  });
});

describe('logs', () => {
  it('searches the recent entries, 200 by default, and opens only daily files by name', async () => {
    const a = setUp();
    for (let i = 0; i < 250; i++) a.log.info('http', `GET /api/data ${i}`);
    a.log.warn('auth', 'Failed sign-in for misty', { password: 'pallet town' });
    const r = a.searchLogs.execute({});
    assert.equal(r.entries.length, 200);
    assert.deepEqual(r.files, []);
    assert.deepEqual(a.searchLogs.execute({ cat: 'auth', text: 'MISTY' }).entries.map((e) => e.data), [{ password: '[hidden]' }]);
    assert.equal(await a.openLogFile.execute({ name: '../auth.json' }), null);
    assert.equal(await a.openLogFile.execute({ name: '2026-10-03.jsonl' }), null); // no log folder
  });
});

describe('page errors', () => {
  it('are logged as errors with who saw them, at most 30 a minute, counting malformed ones', () => {
    const a = setUp();
    assert.deepEqual(a.reportPageError.execute({ report: { message: 'boom', page: 'binder' }, by: { user: 'ash' } }), { ok: true, value: undefined });
    assert.deepEqual(a.log.query({ level: 'error' })[0]?.data, { kind: 'error', user: 'ash' });
    assert.equal(a.reportPageError.execute({ report: { message: 5 }, by: { guest: true } }).ok, false);
    for (let i = 0; i < 30; i++) a.reportPageError.execute({ report: { message: `loop ${i}` }, by: { guest: true } });
    assert.equal(a.log.query({ level: 'error', text: 'Page error' }).length, 29);
    assert.equal(a.log.query({ level: 'warn', text: 'more than 30 page errors' }).length, 1);
    // Past the limit, even a malformed report is dropped unread.
    assert.equal(a.reportPageError.execute({ report: { message: 5 }, by: { guest: true } }).ok, true);
    a.setNow(new Date('2026-10-03T12:01:01.000Z'));
    a.reportPageError.execute({ report: { message: 'later' }, by: { guest: true } });
    assert.equal(a.log.query({ text: 'Page error: later' }).length, 1);
  });
});
