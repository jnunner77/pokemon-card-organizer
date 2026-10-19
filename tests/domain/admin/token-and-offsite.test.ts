import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { offsiteCopyFrom } from '#domain/admin/offsite.ts';
import { checkTokenFormat, NOT_A_TOKEN } from '#domain/admin/pricecharting-token.ts';

describe("PriceCharting's token", () => {
  it('is 20-100 letters and digits, spaces around it dropped', () => {
    const token = 'a1'.repeat(20);
    assert.deepEqual(checkTokenFormat({ token: `  ${token}\n` }), { ok: true, value: token });
    assert.deepEqual(checkTokenFormat({ token: 'short' }), { ok: false, error: { code: 'INVALID_SETTING', message: NOT_A_TOKEN } });
    assert.deepEqual(checkTokenFormat({ token: `${token}-x` }), { ok: false, error: { code: 'INVALID_SETTING', message: NOT_A_TOKEN } });
    assert.deepEqual(checkTokenFormat({}), { ok: false, error: { code: 'INVALID_SETTING', message: 'Invalid input: expected string, received undefined' } });
  });
});

describe('the off-site copy record', () => {
  it('is a UTC time and where the copy went', () => {
    assert.deepEqual(offsiteCopyFrom({ at: '2026-10-03T12:00:00.000Z', where: 'gs://b/x.tar.gz', extra: 1 }), { at: '2026-10-03T12:00:00.000Z', where: 'gs://b/x.tar.gz' });
    assert.equal(offsiteCopyFrom({ at: 'not a date', where: 'x' }), null);
    assert.equal(offsiteCopyFrom({ at: '2026-10-03T12:00:00+02:00', where: 'x' }), null);
    assert.equal(offsiteCopyFrom({ at: '2026-10-03T12:00:00Z', where: '' }), null);
    assert.equal(offsiteCopyFrom([]), null);
  });
});
