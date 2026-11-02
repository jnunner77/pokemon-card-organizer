import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiscardOpenTrade } from '#application/open-trades/discard-open-trade.ts';
import { ListOpenTrades } from '#application/open-trades/list-open-trades.ts';
import { SaveOpenTrade } from '#application/open-trades/save-open-trade.ts';
import { MemoryOpenTradeShelf } from '#infrastructure/memory/open-trades.ts';
import { LocalOpenTradeNews } from '#infrastructure/open-trades/local-news.ts';
import { openTradeRoutes } from '#presentation/open-trades/routes.ts';
import { body, json, serve } from '../fixtures.ts';

async function setUp() {
  const deps = { shelf: new MemoryOpenTradeShelf(), news: new LocalOpenTradeNews(), clock: { now: () => new Date('2026-10-05T18:00:00.000Z') }, activity: { info: () => {}, warn: () => {} } };
  const routes = openTradeRoutes({
    identify: (req) => {
      const role = req.headers['x-role'];
      return role === 'admin' || role === 'editor' || role === 'viewer' ? { name: 'justin', role } : null;
    },
    list: new ListOpenTrades(deps),
    save: new SaveOpenTrade(deps),
    discard: new DiscardOpenTrade(deps),
  });
  const base = await serve((req, res) => routes.handle(req, res));
  const as = (role: string | null, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(role ? { 'x-role': role } : {}) } });
  const put = (id: string, b: unknown, role: string | null = 'editor') => fetch(`${base}/open-trades/${id}`, as(role, json(b, 'PUT')));
  return { base, as, put };
}

describe('open trade routes', () => {
  it('answers 401 to nobody and 403 to viewers', async () => {
    const { base, as } = await setUp();
    assert.equal((await fetch(`${base}/open-trades`)).status, 401);
    for (const [m, p] of [['GET', ''], ['PUT', '/a'], ['DELETE', '/a']] as const) {
      const r = await fetch(`${base}/open-trades${p}`, as('viewer', m === 'PUT' ? json({ baseVersion: 0 }, 'PUT') : { method: m }));
      assert.equal(r.status, 403, m);
    }
  });
  it('creates, lists and replaces a trade', async () => {
    const { base, as, put } = await setUp();
    const made = await put('a', { baseVersion: 0, customer: 'Ash' });
    assert.equal(made.status, 200);
    assert.equal((await body(made)).version, 1);
    const replaced = await put('a', { baseVersion: 1, customer: 'Misty' });
    assert.equal((await body(replaced)).version, 2);
    const list = await body(await fetch(`${base}/open-trades`, as('admin')));
    assert.equal(list.trades.length, 1);
    assert.equal(list.trades[0].customer, 'Misty');
  });
  it('answers 409 for an older version and 410 for a closed trade', async () => {
    const { base, as, put } = await setUp();
    await put('a', { baseVersion: 0 });
    await put('a', { baseVersion: 1, customer: 'x' });
    const stale = await put('a', { baseVersion: 1, customer: 'y' });
    assert.equal(stale.status, 409);
    assert.equal((await body(stale)).code, 'trade_changed');
    await fetch(`${base}/open-trades/a`, as('editor', { method: 'DELETE' }));
    const closed = await put('a', { baseVersion: 2 });
    assert.equal(closed.status, 410);
    assert.equal((await body(closed)).code, 'trade_closed');
  });
  it('answers 409 for an 11th trade', async () => {
    const { put } = await setUp();
    for (let i = 0; i < 10; i++) assert.equal((await put(`t${i}`, { baseVersion: 0 })).status, 200);
    const r = await put('extra', { baseVersion: 0 });
    assert.equal(r.status, 409);
    assert.equal((await body(r)).code, 'too_many_trades');
  });
  it('answers 400 to what is wrong', async () => {
    const { put } = await setUp();
    assert.equal((await put('a', { baseVersion: 0, owner: 'x' })).status, 400);
    assert.equal((await put('a', { baseVersion: -1 })).status, 400);
    assert.equal((await put('a b', { baseVersion: 0 })).status, 400);
    assert.equal((await put('a', { baseVersion: 0, customer: 'x'.repeat(41) })).status, 400);
  });
  it('discards with 204 even when already gone', async () => {
    const { base, as, put } = await setUp();
    await put('a', { baseVersion: 0 });
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/open-trades/a`, as('editor', { method: 'DELETE' }))).status, 204);
  });
});
