import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRetention, isoWeek, retain } from '#domain/backups/retention.ts';

describe('retention', () => {
  // Moved from the vitest suite (tests/legacy/admin.test.ts) with every assertion kept.
  it('keeps days, then weeks, then months', () => {
    const days: string[] = [];
    for (let t = Date.parse('2025-01-01'); t <= Date.parse('2026-10-03'); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
    const keep = [...retain(days, { daily: 14, weekly: 8, monthly: 12 })].sort();
    assert.ok(keep.includes('2026-10-03'));
    assert.ok(keep.includes('2026-09-20')); // within 14 days
    assert.ok(keep.filter((d) => d < '2026-09-20').length > 5); // weekly and monthly copies
    assert.ok(!keep.includes('2025-06-15'));
    assert.ok(keep.length <= 14 + 8 + 12);
    assert.equal(isoWeek('2026-01-01'), '2026-W01');
    assert.equal(isoWeek('2026-10-03'), '2026-W40');
  });

  it('keeps only the newest days when weeks and months are 0', () => {
    assert.deepEqual([...retain(['2026-01-05', '2026-01-06', '2026-02-10', '2026-09-30', '2026-10-03'], { daily: 2, weekly: 0, monthly: 0 })].sort(), ['2026-09-30', '2026-10-03']);
  });

  it('takes the three counts, whole and within their limits, and nothing else', () => {
    assert.deepEqual(checkRetention({ daily: 14, weekly: 8, monthly: 12 }), { ok: true, value: { daily: 14, weekly: 8, monthly: 12 } });
    assert.deepEqual(checkRetention({ daily: 1, weekly: 0, monthly: 0 }), { ok: true, value: { daily: 1, weekly: 0, monthly: 0 } });
    const refused = (input: unknown) => {
      const r = checkRetention(input);
      assert.ok(!r.ok);
      return r.error.message;
    };
    assert.equal(refused({ daily: 0, weekly: 0, monthly: 0 }), 'daily: Too small: at least 1');
    assert.equal(refused({ daily: 61, weekly: 0, monthly: 0 }), 'daily: Too big: at most 60');
    assert.equal(refused({ daily: 1, weekly: 53, monthly: 0 }), 'weekly: Too big: at most 52');
    assert.equal(refused({ daily: 1, weekly: 0, monthly: 1.5 }), 'monthly: Expected a whole number');
    assert.equal(refused({ daily: 1, weekly: 0 }), 'monthly: Required');
    assert.equal(refused({ daily: 1, weekly: 0, monthly: 0, yearly: 1 }), 'Unrecognized field "yearly"');
    assert.equal(refused([]), 'Expected an object');
  });
});
