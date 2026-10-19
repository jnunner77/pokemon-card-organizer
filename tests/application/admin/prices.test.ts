import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setUp } from './fixtures.ts';

const TOKEN = 'abc123'.repeat(5);
const weights = { pricecharting: 40, tcgplayer: 40, cardmarket: 20 };

describe('price settings', () => {
  it('show the schedule, the token state (never the token) and the update’s progress', () => {
    const a = setUp();
    a.token.write(TOKEN);
    a.priceRecord.state = { running: true, done: 3, total: 9, current: { card: 'Mew' }, lastRun: { date: '2026-10-02' } };
    const r = a.readPriceSettings.execute();
    assert.deepEqual(r, {
      available: true,
      schedule: { enabled: true, hour: 5, timeZone: 'America/Vancouver' },
      pricecharting: { set: true, savedAt: '2026-10-03T12:00:00.000Z', usage: { calls: 0, limit: 2000 } },
      running: true,
      done: 3,
      total: 9,
      current: { card: 'Mew' },
      problem: null,
      history: [{ date: '2026-10-02' }],
    });
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    assert.deepEqual(setUp({ prices: false, pricecharting: false }).readPriceSettings.execute(), { available: false, schedule: null, pricecharting: null, running: false, done: 0, total: 0, current: null, problem: null, history: [] });
  });

  it('change the schedule, keeping what was not sent, and log who did', () => {
    const a = setUp({ prices: false });
    assert.deepEqual(a.changePriceSchedule.execute({ actor: 'ash', schedule: { enabled: false, hour: 7 } }), { ok: true, value: { schedule: { enabled: false, hour: 7, cardmarket: true } } });
    assert.deepEqual(a.settings.get().pricing, { enabled: false, hour: 7, cardmarket: true });
    assert.deepEqual(a.log.query({ cat: 'admin' }).map((e) => [e.msg, e.data]), [['ash changed the price update schedule', { enabled: false, hour: 7, cardmarket: true }]]);
    const refused = a.changePriceSchedule.execute({ actor: 'ash', schedule: { enabled: true, hour: 30 } });
    assert.deepEqual(refused, { ok: false, error: { code: 'INVALID_SETTING', message: 'Too big: expected number to be <=23' } });
    assert.equal(a.settings.get().pricing.hour, 7);
  });

  it('change the price method, and let the daily update know', () => {
    const a = setUp();
    const r = a.changePriceMethod.execute({ actor: 'ash', method: { method: 'pricecharting', weights, tolerance: 10 } });
    assert.ok(r.ok);
    assert.deepEqual(a.settings.get().priceMethod, { method: 'pricecharting', weights, tolerance: 10 });
    assert.equal(a.prices.noted, 1);
    assert.equal(a.changePriceMethod.execute({ actor: 'ash', method: { method: 'blend', weights: { pricecharting: 0, tcgplayer: 0, cardmarket: 0 }, tolerance: 10 } }).ok, false);
    assert.equal(a.prices.noted, 1);
  });
});

describe("PriceCharting's token", () => {
  it('is saved only once PriceCharting accepts it, and never logged', async () => {
    const a = setUp();
    assert.deepEqual(await a.saveToken.execute({ actor: 'ash', body: { token: 'short' } }), { ok: false, error: { code: 'INVALID_SETTING', message: "That isn't a PriceCharting API token: copy the 40-character token from PriceCharting's Subscription page (API/Download)." } });
    assert.deepEqual(await a.saveToken.execute({ actor: 'ash', body: { token: TOKEN } }), { ok: false, error: { code: 'TOKEN_REFUSED' } });
    a.account.failure = 'timed out';
    assert.deepEqual(await a.saveToken.execute({ actor: 'ash', body: { token: TOKEN } }), { ok: false, error: { code: 'TOKEN_CHECK_FAILED', message: 'timed out' } });
    assert.equal(a.token.read(), null);
    a.account.failure = null;
    a.account.known.add(TOKEN);
    assert.deepEqual(await a.saveToken.execute({ actor: 'ash', body: { token: ` ${TOKEN} ` } }), { ok: true, value: { pricecharting: { set: true, savedAt: '2026-10-03T12:00:00.000Z' } } });
    assert.equal(a.token.read(), TOKEN);
    assert.equal(a.prices.noted, 1);
    assert.ok(!JSON.stringify(a.log.query()).includes(TOKEN));
  });

  it('is removed, and what PriceCharting said is forgotten', () => {
    const a = setUp();
    a.token.write(TOKEN);
    assert.deepEqual(a.removeToken.execute({ actor: 'ash' }), { ok: true, value: { pricecharting: { set: false, savedAt: null } } });
    assert.equal(a.account.forgotten, 1);
    assert.equal(a.log.query({ cat: 'admin' })[0]?.msg, 'ash removed the PriceCharting API token');
  });

  it('is unavailable without PriceCharting or the daily update', async () => {
    assert.deepEqual(await setUp({ pricecharting: false }).saveToken.execute({ actor: 'ash', body: { token: TOKEN } }), { ok: false, error: { code: 'PRICECHARTING_UNAVAILABLE' } });
    assert.deepEqual(setUp({ prices: false }).removeToken.execute({ actor: 'ash' }), { ok: false, error: { code: 'PRICECHARTING_UNAVAILABLE' } });
  });
});
