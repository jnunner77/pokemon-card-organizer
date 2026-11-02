import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiscardOpenTrade } from '#application/open-trades/discard-open-trade.ts';
import type { OpenTradeDeps } from '#application/open-trades/deps.ts';
import { ListOpenTrades } from '#application/open-trades/list-open-trades.ts';
import type { OpenTradeChange } from '#application/open-trades/ports.ts';
import { SaveOpenTrade } from '#application/open-trades/save-open-trade.ts';
import { MemoryOpenTradeShelf } from '#infrastructure/memory/open-trades.ts';
import { LocalOpenTradeNews } from '#infrastructure/open-trades/local-news.ts';

function setUp() {
  const shelf = new MemoryOpenTradeShelf();
  const news = new LocalOpenTradeNews();
  const heard: OpenTradeChange[] = [];
  news.subscribe((c) => heard.push(c));
  const logged: string[] = [];
  const deps: OpenTradeDeps = { shelf, news, clock: { now: () => new Date('2026-10-05T18:00:00.000Z') }, activity: { info: (m) => void logged.push(m), warn: (m) => void logged.push(m) } };
  return { shelf, heard, logged, save: new SaveOpenTrade(deps), discard: new DiscardOpenTrade(deps), list: new ListOpenTrades(deps) };
}
const put = (t: ReturnType<typeof setUp>, id: string, baseVersion = 0, customer = 'Ash') => t.save.execute({ actor: 'justin', id, baseVersion, content: { customer } });

describe('open trades', () => {
  it('publishes a view of a saved trade and logs it without the customer', async () => {
    const t = setUp();
    const r = await put(t, 'a');
    assert.ok(r.ok && r.value.number === 1);
    assert.equal(t.heard.length, 1);
    assert.equal(t.heard[0]?.trade?.customer, 'Ash');
    assert.deepEqual(t.logged, ['justin opened Trade 1']);
  });
  it('neither publishes nor saves a save that changes nothing', async () => {
    const t = setUp();
    await put(t, 'a');
    await put(t, 'a', 1);
    assert.equal(t.heard.length, 1);
    assert.equal(t.shelf.saves, 1);
  });
  it('saves nothing when refused', async () => {
    const t = setUp();
    assert.equal((await put(t, 'a', 4)).ok, false);
    assert.equal((await t.save.execute({ actor: 'j', id: 'a', baseVersion: 0, content: { customer: 'x'.repeat(41) } })).ok, false);
    assert.equal(t.shelf.saves, 0);
    assert.equal(t.heard.length, 0);
  });
  it('refuses an invalid id', async () => {
    const t = setUp();
    const r = await t.save.execute({ actor: 'j', id: 'a b', baseVersion: 0, content: {} });
    assert.deepEqual(!r.ok && r.error.code, 'INVALID_ID');
    const d = await t.discard.execute({ actor: 'j', id: 'a b' });
    assert.deepEqual(!d.ok && d.error.code, 'INVALID_ID');
  });
  it('discards and publishes null, but says nothing for a missing trade', async () => {
    const t = setUp();
    await put(t, 'a');
    const r = await t.discard.execute({ actor: 'justin', id: 'a', reason: 'recorded' });
    assert.ok(r.ok && r.value.discarded);
    assert.deepEqual(t.heard[1], { id: 'a', trade: null });
    assert.equal(t.logged[1], 'justin closed Trade 1: recorded');
    const again = await t.discard.execute({ actor: 'justin', id: 'a' });
    assert.ok(again.ok && !again.value.discarded);
    assert.equal(t.heard.length, 2);
  });
  it('lists by number', async () => {
    const t = setUp();
    await put(t, 'a');
    await put(t, 'b');
    await t.discard.execute({ actor: 'j', id: 'a' });
    await put(t, 'c');
    assert.deepEqual((await t.list.execute()).map((v) => [v.id, v.number]), [['c', 1], ['b', 2]]);
  });
});
