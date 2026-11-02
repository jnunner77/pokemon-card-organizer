import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ok } from '#shared/result.ts';
import { FileOpenTradeShelf } from '#infrastructure/open-trades/open-trade-file.ts';
import { LocalOpenTradeNews } from '#infrastructure/open-trades/local-news.ts';
import { saveOpenTrade, type OpenTradeId } from '#domain/open-trades/open-trade.ts';

const side = { pct: '100', cash: '', items: [] };
const add = (shelf: FileOpenTradeShelf) =>
  shelf.change((d) => {
    const r = saveOpenTrade(d, { id: 'a' as OpenTradeId, baseVersion: 0, content: { customer: 'Ash', dealer: side, mine: side }, by: 'justin', at: '2026-10-05T18:00:00.000Z' });
    d.changed = r.ok && r.value.changed;
    return r;
  });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'open-trades-'));

describe('the open trades file', () => {
  it('keeps trades across a restart, readable only by the server', async () => {
    const d = dir();
    await add(new FileOpenTradeShelf({ dataDir: d, onDamaged: () => {} }));
    const book = await new FileOpenTradeShelf({ dataDir: d, onDamaged: () => {} }).read();
    assert.equal(book.trades[0]?.customer, 'Ash');
    assert.equal(fs.statSync(path.join(d, 'open-trades.json')).mode & 0o077, 0);
  });
  it('sets a damaged file aside and starts empty', async () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'open-trades.json'), '{ nope');
    const said: string[] = [];
    const shelf = new FileOpenTradeShelf({ dataDir: d, onDamaged: (m) => said.push(m) });
    assert.deepEqual((await shelf.read()).trades, []);
    assert.equal(said.length, 1);
    assert.match(said[0] ?? '', /Open trades start empty/);
    assert.ok(fs.readdirSync(d).some((f) => f.startsWith('open-trades.json.damaged-')));
  });
  it('writes nothing for work that fails or changes nothing', async () => {
    const d = dir();
    const shelf = new FileOpenTradeShelf({ dataDir: d, onDamaged: () => {} });
    await shelf.change(() => ({ ok: false as const, error: 'no' }));
    await shelf.change(() => ok(1));
    assert.equal(fs.existsSync(path.join(d, 'open-trades.json')), false);
  });
});

describe('open trade news', () => {
  it('goes on to other listeners when one throws', () => {
    const news = new LocalOpenTradeNews();
    const heard: string[] = [];
    news.subscribe(() => {
      throw new Error('boom');
    });
    news.subscribe((c) => heard.push(c.id));
    news.publish({ id: 'a', trade: null });
    assert.deepEqual(heard, ['a']);
  });
});
