import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SourceUnavailable } from '#application/catalog/ports.ts';
import { TcgCsvClient } from '#infrastructure/catalog/tcgcsv.ts';
import { type Fetcher, retryPolicy } from '#infrastructure/http/get.ts';

const BASE = 'https://tcgcsv.com/tcgplayer/3';

beforeEach(() => {
  retryPolicy.baseMs = 1;
});

/** tcgcsv.com answering from these paths, noting what it was asked; `fail` makes it answer 503. */
function tcgcsv(routes: Record<string, unknown>, asked: string[], fail = { on: false }): Fetcher {
  return async (url) => {
    asked.push(url.replace(BASE, ''));
    if (fail.on) return new Response('', { status: 503 });
    const p = url.replace(BASE, '');
    return p in routes ? Response.json({ success: true, results: routes[p] }) : Response.json({ success: false });
  };
}

describe("TCGplayer's catalog from tcgcsv.com", () => {
  it('downloads the list of sets and each set at most once a day', async () => {
    const asked: string[] = [];
    let at = new Date('2026-10-03T12:00:00Z');
    const client = new TcgCsvClient({ fetcher: tcgcsv({ '/groups': [{ groupId: 1, name: 'Celebrations' }], '/1/products': [{ productId: 5, groupId: 1, name: 'Ho-Oh' }], '/1/prices': [] }, asked), now: () => at, gapMs: 0 });
    assert.deepEqual(await client.groupList(), [{ groupId: 1, name: 'Celebrations' }]);
    assert.deepEqual(await client.group(1), { products: [{ productId: 5, groupId: 1, name: 'Ho-Oh' }], prices: [] });
    await client.groupList();
    await client.group(1);
    assert.deepEqual(asked, ['/groups', '/1/products', '/1/prices']);
    at = new Date('2026-10-04T12:00:00Z');
    await client.groupList();
    assert.equal(client.downloads, 4);
  });

  it("stops asking after failing three times in a row, until it's reset", async () => {
    const asked: string[] = [];
    const fail = { on: true };
    const client = new TcgCsvClient({ fetcher: tcgcsv({ '/groups': [] }, asked, fail), gapMs: 0 });
    for (let i = 0; i < 3; i++) await assert.rejects(client.groupList(), SourceUnavailable);
    const tries = asked.length;
    await assert.rejects(client.groupList(), /kept failing/);
    assert.equal(asked.length, tries);
    fail.on = false;
    client.reset();
    assert.deepEqual(await client.groupList(), []);
  });

  it('fails a download without results', async () => {
    const client = new TcgCsvClient({ fetcher: tcgcsv({}, []), gapMs: 0 });
    await assert.rejects(client.group(9), /tcgcsv\.com sent no results/);
  });
});
