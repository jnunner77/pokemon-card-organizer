import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SourceUnavailable } from '#application/catalog/ports.ts';
import { TcgdexCardDatabase } from '#infrastructure/catalog/tcgdex.ts';
import { type Fetcher, retryPolicy } from '#infrastructure/http/get.ts';

const API = 'https://api.tcgdex.net/v2/en';

/** TCGdex answering from these paths (404 for the rest), noting what it was asked. */
function tcgdex(routes: Record<string, unknown>, asked: string[] = []): Fetcher {
  return async (url) => {
    const p = url.replace(API, '');
    asked.push(p);
    return p in routes ? Response.json(routes[p]) : new Response('{"status":404}', { status: 404 });
  };
}

beforeEach(() => {
  retryPolicy.baseMs = 1;
});

describe('TCGdex over its API', () => {
  it('asks by name, number, id and set, as TCGdex wants them', async () => {
    const asked: string[] = [];
    const db = new TcgdexCardDatabase({ fetcher: tcgdex({ '/cards?name=Pok%C3%A9dex': [{ id: 'base1-87', localId: '87', name: 'Pokédex' }], '/cards?localId=87': [], '/sets/base1': { id: 'base1', name: 'Base Set' } }, asked) });
    assert.deepEqual(await db.cardsNamed('Pokédex'), [{ id: 'base1-87', localId: '87', name: 'Pokédex' }]);
    assert.deepEqual(await db.cardsNumbered('87'), []);
    assert.deepEqual(await db.set('base1'), { id: 'base1', name: 'Base Set', cards: [] });
    await db.setsNamed('Base Set').catch(() => undefined);
    await db.card('swshp-SWSH050').catch(() => undefined);
    assert.deepEqual(asked, ['/cards?name=Pok%C3%A9dex', '/cards?localId=87', '/sets/base1', '/sets?name=Base%20Set', '/cards/swshp-SWSH050']);
  });

  it('remembers answers for an hour (sets for a day), and asks again after a failure', async () => {
    const asked: string[] = [];
    let at = new Date('2026-10-03T12:00:00Z');
    const routes: Record<string, unknown> = { '/cards?name=Pikachu': [], '/sets/sv05': { id: 'sv05', name: 'Temporal Forces' } };
    const db = new TcgdexCardDatabase({ fetcher: tcgdex(routes, asked), clock: { now: () => at } });
    await db.cardsNamed('Pikachu');
    await db.cardsNamed('Pikachu');
    await db.set('sv05');
    at = new Date(at.getTime() + 2 * 3_600_000);
    await db.cardsNamed('Pikachu');
    await db.set('sv05');
    assert.deepEqual(asked, ['/cards?name=Pikachu', '/sets/sv05', '/cards?name=Pikachu']);
    await assert.rejects(db.card('gone'));
    await assert.rejects(db.card('gone'));
    assert.equal(asked.filter((p) => p === '/cards/gone').length, 2);
  });

  it("says when it hasn't the card (404) or can't be reached", async () => {
    const db = new TcgdexCardDatabase({ fetcher: tcgdex({}) });
    await assert.rejects(db.card('nope'), (e: unknown) => e instanceof SourceUnavailable && e.status === 404 && e.message === 'api.tcgdex.net answered 404');
    const down = new TcgdexCardDatabase({
      fetcher: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.tcgdex.net');
      },
    });
    await assert.rejects(down.sets(), (e: unknown) => e instanceof SourceUnavailable && e.status === null && e.message === "Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND api.tcgdex.net");
  });

  it("reads TCG Pocket's sets once a day, and none when TCGdex doesn't answer", async () => {
    const asked: string[] = [];
    const db = new TcgdexCardDatabase({ fetcher: tcgdex({ '/series/tcgp': { sets: [{ id: 'A1' }, { id: 'B2' }] } }, asked) });
    assert.deepEqual([...(await db.pocketSets())], ['A1', 'B2']);
    await db.pocketSets();
    assert.equal(asked.length, 1);
    assert.deepEqual([...(await new TcgdexCardDatabase({ fetcher: tcgdex({}) }).pocketSets())], []);
  });

  it('reads anything but a list as no cards or sets', async () => {
    const db = new TcgdexCardDatabase({ fetcher: tcgdex({ '/sets': { error: 'odd' }, '/cards?name=X': null }) });
    assert.deepEqual(await db.sets(), []);
    assert.deepEqual(await db.cardsNamed('X'), []);
  });
});
