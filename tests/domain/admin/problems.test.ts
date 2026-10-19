import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogEntry } from '#domain/admin/log.ts';
import { checkSeenMark, groupProblems, problemFeed, problemKey, seenUpTo, summarizeProblems } from '#domain/admin/problems.ts';

let id = 0;
const entry = (level: 'warn' | 'error', msg: string, at: string, data?: Record<string, unknown>): LogEntry => ({ id: ++id, at, level, cat: 'pricing', msg, ...(data ? { data } : {}) });

describe('problems', () => {
  it('group messages that differ only in numbers, ids or addresses, newest first', () => {
    const groups = groupProblems([
      entry('warn', 'PriceCharting answered 500', '2026-10-03T12:00:00.000Z'),
      entry('error', 'Housekeeping failed: ENOSPC', '2026-10-03T12:00:30.000Z'),
      entry('warn', 'PriceCharting answered 502', '2026-10-03T12:01:00.000Z', { card: 'c1' }),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.count, g.msg, g.first, g.last, g.data]),
      [
        [2, 'PriceCharting answered 502', '2026-10-03T12:00:00.000Z', '2026-10-03T12:01:00.000Z', { card: 'c1' }],
        [1, 'Housekeeping failed: ENOSPC', '2026-10-03T12:00:30.000Z', '2026-10-03T12:00:30.000Z', undefined],
      ],
    );
    assert.equal(problemKey({ level: 'warn', cat: 'http', msg: 'POST /api/x 429 12 ms' }), problemKey({ level: 'warn', cat: 'http', msg: 'POST /api/x 429 340 ms' }));
    assert.equal(problemKey({ level: 'warn', cat: 'app', msg: 'card 0123abcd9f gone\nstack' }), problemKey({ level: 'warn', cat: 'app', msg: 'card ffee00112233 gone' }));
    assert.notEqual(problemKey({ level: 'warn', cat: 'http', msg: 'a' }), problemKey({ level: 'error', cat: 'http', msg: 'a' }));
  });

  it('put errors before warnings logged at the same moment, and keep at most 100 groups', () => {
    const at = '2026-10-03T12:00:00.000Z';
    assert.deepEqual(groupProblems([entry('warn', 'w', at), entry('error', 'e', at)]).map((g) => g.level), ['error', 'warn']);
    const many = Array.from({ length: 120 }, (_, i) => entry('warn', `problem ${'x'.repeat(i)}`, at));
    assert.equal(summarizeProblems(many, null).groups.length, 100);
  });

  it('count the problems since they were last seen, or all kept', () => {
    const entries = [entry('error', 'old error', '2026-10-03T11:00:00.000Z'), entry('warn', 'new warning', '2026-10-03T12:01:00.000Z'), entry('error', 'new error', '2026-10-03T12:02:00.000Z')];
    const source = { problems: (since: string | null) => (since ? entries.filter((e) => e.at > since) : entries) };
    const seenAt = '2026-10-03T12:00:00.000Z';
    assert.deepEqual({ ...problemFeed(source, seenAt), groups: undefined }, { seenAt, errors: 1, warnings: 1, latest: '2026-10-03T12:02:00.000Z', groups: undefined });
    assert.equal(problemFeed(source, seenAt, { all: true }).errors, 2);
    assert.deepEqual(problemFeed(source, '2026-10-03T13:00:00.000Z'), { seenAt: '2026-10-03T13:00:00.000Z', errors: 0, warnings: 0, groups: [], latest: null });
  });

  it('mark as seen up to the newest problem the page showed, never past now', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    assert.equal(seenUpTo('2026-10-03T11:59:00.000Z', now), '2026-10-03T11:59:00.000Z');
    assert.equal(seenUpTo('2026-10-03T12:30:00.000Z', now), now.toISOString());
    assert.equal(seenUpTo(undefined, now), now.toISOString());
    assert.deepEqual(checkSeenMark(undefined), { ok: true, value: undefined });
    assert.deepEqual(checkSeenMark({ other: 1 }), { ok: true, value: undefined });
    assert.deepEqual(checkSeenMark({ upTo: '2024-02-29T00:00:00.5Z' }), { ok: true, value: '2024-02-29T00:00:00.5Z' });
    assert.deepEqual(checkSeenMark({ upTo: '2023-02-29T00:00:00Z' }), { ok: false, error: { code: 'INVALID_SEEN_MARK', message: 'Invalid ISO datetime' } });
    assert.deepEqual(checkSeenMark({ upTo: '2026-10-03T12:00Z' }), { ok: false, error: { code: 'INVALID_SEEN_MARK', message: 'Invalid ISO datetime' } });
    assert.deepEqual(checkSeenMark({ upTo: 5 }), { ok: false, error: { code: 'INVALID_SEEN_MARK', message: 'Invalid input: expected string, received number' } });
    assert.deepEqual(checkSeenMark([]), { ok: false, error: { code: 'INVALID_SEEN_MARK', message: 'Invalid input: expected object, received array' } });
  });
});
