import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adminSettingsFrom, checkPriceMethod, checkPricingSchedule, DEFAULT_ADMIN_SETTINGS } from '#domain/admin/settings.ts';

const refused = (r: { ok: boolean; error?: { message: string } }) => {
  assert.ok(!r.ok);
  return r.error?.message;
};
const weights = { pricecharting: 40, tcgplayer: 40, cardmarket: 20 };

describe('admin settings', () => {
  it('take a price update schedule: on or off, a whole hour 0-23, and whether Cardmarket is compared', () => {
    assert.deepEqual(checkPricingSchedule({ enabled: false, hour: 7 }), { ok: true, value: { enabled: false, hour: 7 } });
    assert.deepEqual(checkPricingSchedule({ enabled: true, hour: 0, cardmarket: false }), { ok: true, value: { enabled: true, hour: 0, cardmarket: false } });
    assert.equal(refused(checkPricingSchedule({ enabled: true, hour: 24 })), 'Too big: expected number to be <=23');
    assert.equal(refused(checkPricingSchedule({ enabled: true, hour: -1 })), 'Too small: expected number to be >=0');
    assert.equal(refused(checkPricingSchedule({ enabled: true, hour: 1.5 })), 'Invalid input: expected int, received number');
    assert.equal(refused(checkPricingSchedule({ enabled: 'yes', hour: 5 })), 'Invalid input: expected boolean, received string');
    assert.equal(refused(checkPricingSchedule({ hour: 5 })), 'Invalid input: expected boolean, received undefined');
    assert.equal(refused(checkPricingSchedule({ enabled: true, hour: 5, pricecharting: true })), 'Unrecognized key: "pricecharting"');
    assert.equal(refused(checkPricingSchedule({ enabled: true, hour: 5, a: 1, b: 2 })), 'Unrecognized keys: "a", "b"');
    assert.equal(refused(checkPricingSchedule([])), 'Invalid input: expected object, received array');
    assert.equal(refused(checkPricingSchedule(undefined)), 'Invalid input: expected object, received undefined');
  });

  it('take a price method that gives at least one source a weight', () => {
    assert.deepEqual(checkPriceMethod({ tolerance: 25, weights, method: 'highest' }), { ok: true, value: { method: 'highest', weights, tolerance: 25 } });
    assert.equal(refused(checkPriceMethod({ method: 'blend', weights: { pricecharting: 0, tcgplayer: 0, cardmarket: 0 }, tolerance: 25 })), 'Give at least one source a weight.');
    assert.equal(refused(checkPriceMethod({ method: 'average', weights, tolerance: 25 })), 'Invalid option: expected one of "blend"|"highest"|"pricecharting"');
    assert.equal(refused(checkPriceMethod({ method: 'blend', weights: { ...weights, tcgplayer: 101 }, tolerance: 25 })), 'Too big: expected number to be <=100');
    assert.equal(refused(checkPriceMethod({ method: 'blend', weights: { ...weights, ebay: 1 }, tolerance: 25 })), 'Unrecognized key: "ebay"');
    assert.equal(refused(checkPriceMethod({ method: 'blend', weights, tolerance: 0 })), 'Too small: expected number to be >=1');
    // The first problem in the fields' order, before the weights' sum.
    assert.equal(refused(checkPriceMethod({ method: 'blend', weights: { pricecharting: 0, tcgplayer: 0, cardmarket: 0 }, tolerance: 1001 })), 'Too big: expected number to be <=1000');
    assert.equal(refused(checkPriceMethod({ method: 'blend', weights })), 'Invalid input: expected number, received undefined');
  });

  it('read what was saved over the defaults, dropping the old "use PriceCharting" switch and values of the wrong kind', () => {
    assert.deepEqual(adminSettingsFrom(null, DEFAULT_ADMIN_SETTINGS), DEFAULT_ADMIN_SETTINGS);
    const fromEnv = { ...DEFAULT_ADMIN_SETTINGS, pricing: { enabled: false, hour: 6 } };
    assert.deepEqual(adminSettingsFrom({ pricing: { hour: 7, pricecharting: true }, backups: { daily: 3 } }, fromEnv), {
      backups: { daily: 3, weekly: 8, monthly: 12 },
      pricing: { enabled: false, hour: 7 },
      lastFullBackupAt: null,
    });
    const saved = adminSettingsFrom({ priceMethod: { method: 'highest', weights, tolerance: 25 }, lastFullBackupAt: '2026-10-01T00:00:00.000Z', problemsSeenAt: null, pricing: { hour: 'seven' } }, DEFAULT_ADMIN_SETTINGS);
    assert.deepEqual(saved, { ...DEFAULT_ADMIN_SETTINGS, priceMethod: { method: 'highest', weights, tolerance: 25 }, lastFullBackupAt: '2026-10-01T00:00:00.000Z', problemsSeenAt: null });
    assert.equal(adminSettingsFrom({ priceMethod: { method: 'nope' } }, DEFAULT_ADMIN_SETTINGS).priceMethod, null);
  });
});
