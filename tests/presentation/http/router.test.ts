import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Router } from '#presentation/http/router.ts';
import { serve } from '../fixtures.ts';

describe('Router', () => {
  it('matches method and path, any case, with or without a trailing slash, and decodes params', async () => {
    const seen: unknown[] = [];
    const router = new Router().add('PUT', '/docs/:collection/:id', async (_req, res, params) => {
      seen.push(params);
      res.end();
    });
    const base = await serve(router.handle);
    assert.equal((await fetch(`${base}/DOCS/cards/a%20b/?x=1`, { method: 'PUT' })).status, 200);
    assert.equal((await fetch(`${base}/docs/cards/a`, { method: 'GET' })).status, 404);
    assert.equal((await fetch(`${base}/docs/cards`, { method: 'PUT' })).status, 404);
    assert.deepEqual(seen, [{ collection: 'cards', id: 'a b' }]);
    assert.equal(router.owns('PUT', '/docs/cards/c1'), true);
    assert.equal(router.owns('POST', '/docs/cards/c1'), false);
  });

  it('answers HEAD with a GET route', async () => {
    const router = new Router().add('GET', '/data', async (_req, res) => void res.end('{}'));
    const base = await serve(router.handle);
    assert.equal((await fetch(`${base}/data`, { method: 'HEAD' })).status, 200);
    assert.equal(router.owns('HEAD', '/data'), true);
  });
});
