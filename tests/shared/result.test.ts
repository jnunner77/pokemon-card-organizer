import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertNever, err, ok } from '#shared/result.ts';

describe('Result', () => {
  it('holds a value or an error', () => {
    assert.deepEqual(ok(3), { ok: true, value: 3 });
    assert.deepEqual(err({ code: 'NOPE' }), { ok: false, error: { code: 'NOPE' } });
  });

  it('assertNever throws on a case nobody handled', () => {
    assert.throws(() => assertNever('surprise' as never), /Unhandled case: "surprise"/);
  });
});
