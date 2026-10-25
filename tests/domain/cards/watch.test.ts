import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardValue } from '#domain/cards/value.ts';
import { activeTargets, alertsAfterCheck, dueWatches, isWatched, ownsCard, reaches, watchTargets } from '#domain/cards/watch.ts';
import { AT, card, value } from '../fixtures.ts';

const at = AT.toISOString();
const none = new Set<'buy' | 'sell'>();
const both = new Set<'buy' | 'sell'>(['buy', 'sell']);

describe('Price watches', () => {
  it('reads the prices a card is watched for, ignoring blanks and nonsense', () => {
    assert.deepEqual(watchTargets({}), { buy: null, sell: null });
    assert.deepEqual(watchTargets({ watch: { buy: 5, sell: 0 } }), { buy: 5, sell: null });
    assert.deepEqual(watchTargets({ watch: { buy: '5', sell: 20 } }), { buy: null, sell: 20 });
  });

  it('watches selling only on a card the person has', () => {
    const watch = { buy: 5, sell: 20 };
    assert.deepEqual(activeTargets({ watch, status: 'binder' }), { buy: 5, sell: 20 });
    for (const not of [{ placeholder: true }, { watchlist: true, placeholder: true }, { status: 'sold' }, { status: 'traded' }]) {
      assert.deepEqual(activeTargets({ watch, ...not }), { buy: 5, sell: null });
      assert.equal(ownsCard(not), false);
    }
    assert.equal(isWatched({ watch: { sell: 20 }, placeholder: true }), false);
    assert.equal(isWatched({ watch: { sell: 20 } }), true);
  });

  it('is reached at or below a buy price, at or above a sell price', () => {
    assert.equal(reaches('buy', 5, 5), true);
    assert.equal(reaches('buy', 5, 5.01), false);
    assert.equal(reaches('sell', 20, 20), true);
    assert.equal(reaches('sell', 20, 19.99), false);
  });

  it('is due once reached, until it is emailed for that price', () => {
    const c = { watch: { buy: 5, sell: 20 } };
    assert.deepEqual(dueWatches(c, 4.5), [{ side: 'buy', target: 5, price: 4.5 }]);
    assert.deepEqual(dueWatches(c, 25), [{ side: 'sell', target: 20, price: 25 }]);
    assert.deepEqual(dueWatches(c, 10), []);
    assert.deepEqual(dueWatches(c, null), []);
    // Compared to the cent, as shown: 5.004 is $5.00.
    assert.deepEqual(dueWatches(c, 5.004), [{ side: 'buy', target: 5, price: 5 }]);
    const emailed = { ...c, watchAlerts: { buy: { at, target: 5, price: 4.5 } } };
    assert.deepEqual(dueWatches(emailed, 4), []);
    // A new price is a new watch.
    assert.deepEqual(dueWatches({ ...emailed, watch: { buy: 4.75 } }, 4), [{ side: 'buy', target: 4.75, price: 4 }]);
  });

  it('records what was emailed, and clears it once the value moves back', () => {
    const c = { watch: { buy: 5, sell: 20 } };
    assert.deepEqual(alertsAfterCheck(c, 4.5, both, at), { watchAlerts: { buy: { at, target: 5, price: 4.5 } } });
    // Not emailed (no email set up, or it failed): nothing recorded, so it's tried again.
    assert.equal(alertsAfterCheck(c, 4.5, none, at), null);
    const emailed = { ...c, watchAlerts: { buy: { at: 'earlier', target: 5, price: 4.5 } } };
    assert.equal(alertsAfterCheck(emailed, 4, both, at), null);
    assert.deepEqual(alertsAfterCheck(emailed, 6, none, at), { watchAlerts: null });
    // No price today: left as it was.
    assert.equal(alertsAfterCheck(emailed, null, none, at), null);
    // Its price changed or the watch was removed: cleared.
    assert.deepEqual(alertsAfterCheck({ ...emailed, watch: { buy: 3 } }, 4, none, at), { watchAlerts: null });
    assert.deepEqual(alertsAfterCheck({ ...emailed, watch: null }, 4, none, at), { watchAlerts: null });
    // One side kept, the other recorded.
    const sold = { watch: { buy: 30, sell: 20 }, watchAlerts: { buy: { at: 'earlier', target: 30, price: 25 } } };
    assert.deepEqual(alertsAfterCheck(sold, 25, both, at), { watchAlerts: { buy: { at: 'earlier', target: 30, price: 25 }, sell: { at, target: 20, price: 25 } } });
  });

  it('is recorded on the card', () => {
    const c = card('c1', { watch: { buy: 25 } });
    assert.equal(value(c.noteWatchCheck(21.2, new Set(['buy']), AT)), true);
    assert.deepEqual(c.fields['watchAlerts'], { buy: { at, target: 25, price: 21.2 } });
    assert.equal(value(c.noteWatchCheck(21.2, new Set(['buy']), AT)), false);
    assert.equal(c.pullEvents().length, 1);
  });

  it('refuses a watch price that is not a positive number', () => {
    assert.equal(card('c1').merge({ watch: { buy: -1 } }, AT).ok, false);
    assert.equal(card('c1').merge({ watch: { buy: 0 } }, AT).ok, false);
    assert.equal(card('c1').merge({ watch: { buy: 5, sell: null }, watchlist: true }, AT).ok, true);
  });
});

describe('A card\'s value', () => {
  const adjust = (_c: unknown, p: Readonly<Record<string, unknown>>) => (typeof p['amount'] === 'number' ? p['amount'] : null);
  it('is its latest market price or sold comp, in CAD', () => {
    const prices = [
      { type: 'market', amount: 10, currency: 'CAD', date: '2026-10-01' },
      { type: 'paid', amount: 1, currency: 'CAD', date: '2026-10-09' },
      { type: 'comp', amount: 8, currency: 'USD', date: '2026-10-05' },
    ];
    assert.equal(cardValue({ prices }, 1.5, adjust), 12);
    assert.equal(cardValue({ prices: [] }, 1.5, adjust), null);
    assert.equal(cardValue({}, 1.5, adjust), null);
  });
});
