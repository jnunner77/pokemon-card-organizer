import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Caller } from '#application/access.ts';
import type { PhotoFile } from '#application/photos/ports.ts';
import { err, ok } from '#shared/result.ts';
import { photoRoutes, type PhotoRouteDeps } from '#presentation/photos/routes.ts';
import { combine } from '#presentation/http/router.ts';
import http from 'node:http';
import { serve } from '../fixtures.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);
const id = 'c'.repeat(32);
const modifiedAt = new Date('2026-10-18T12:00:00.000Z');
const file = (): PhotoFile => ({ type: 'image/jpeg', bytes: JPEG.length, modifiedAt, content: (async function* () { yield JPEG; })() });

async function setUp(over: Partial<PhotoRouteDeps> = {}) {
  const asked: unknown[] = [];
  const routes = photoRoutes({
    identify: (req) => {
      const role = req.headers['x-role'];
      return role === 'viewer' || role === 'editor' || role === 'admin' ? ({ name: 'justin', role } satisfies Caller) : null;
    },
    uploadPhoto: { execute: async (input) => (asked.push({ bytes: Buffer.from(input.bytes).toString('hex') }), input.bytes.length ? ok({ id: id as never, type: 'image/jpeg' as const }) : err({ code: 'PHOTO_EMPTY' as const })) },
    deletePhoto: { execute: async (input) => void asked.push(input) },
    openPhoto: { execute: async (input) => (input.id === id ? file() : null) },
    ...over,
  });
  return { base: await serve(combine(routes.api, routes.root).handle), asked };
}
const as = (role: string, init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers);
  headers.set('X-Role', role);
  return { ...init, headers };
};

describe('photo routes', () => {
  it('store an upload of any type and answer with its id', async () => {
    const { base, asked } = await setUp();
    const r = await fetch(`${base}/assets`, as('editor', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: JPEG }));
    assert.deepEqual([r.status, await r.json()], [201, { id, type: 'image/jpeg' }]);
    assert.deepEqual(asked, [{ bytes: JPEG.toString('hex') }]);
  });

  it('refuse an upload with no photo, one that is not a picture, or one too large', async () => {
    const { base } = await setUp({ uploadPhoto: { execute: async () => err({ code: 'NOT_A_PICTURE' as const }) } });
    const svg = await fetch(`${base}/assets`, as('editor', { method: 'POST', body: '<svg onload=alert(1)>' }));
    assert.deepEqual([svg.status, await svg.json()], [415, { error: "That file isn't a JPG, PNG, WebP or GIF picture", code: 'unsupported_type' }]);
    const big = await fetch(`${base}/assets`, as('editor', { method: 'POST', body: Buffer.alloc(20 * 1024 * 1024 + 1) }));
    assert.deepEqual([big.status, await big.json()], [413, { error: 'That upload is too large', code: 'too_large' }]);
    const empty = await setUp();
    const none = await fetch(`${empty.base}/assets`, as('editor', { method: 'POST', body: '' }));
    assert.deepEqual([none.status, await none.json()], [400, { error: 'No photo was sent', code: 'invalid_argument' }]);
  });

  it('need an editor to upload or delete, and a signed-in viewer to see one', async () => {
    const { base, asked } = await setUp();
    assert.equal((await fetch(`${base}/assets`, as('viewer', { method: 'POST', body: JPEG }))).status, 403);
    assert.equal((await fetch(`${base}/assets/${id}`, as('viewer', { method: 'DELETE' }))).status, 403);
    assert.equal((await fetch(`${base}/blob/${id}`)).status, 401);
    assert.deepEqual(asked, []);
    assert.equal((await fetch(`${base}/assets/${id}`, as('editor', { method: 'DELETE' }))).status, 204);
  });

  it('serve a photo with long caching, answer 304 for a current copy, and 404 with no body for none', async () => {
    const { base } = await setUp();
    const r = await fetch(`${base}/blob/${id}`, as('viewer'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG);
    const etag = r.headers.get('etag') ?? '';
    assert.equal((await fetch(`${base}/blob/${id}`, as('viewer', { headers: { 'If-None-Match': etag } }))).status, 304);
    assert.equal((await fetch(`${base}/blob/${id}`, as('viewer', { headers: { 'If-Modified-Since': modifiedAt.toUTCString() } }))).status, 304);
    const head = await fetch(`${base}/blob/${id}`, as('viewer', { method: 'HEAD' }));
    assert.deepEqual([head.status, head.headers.get('content-length')], [200, String(JPEG.length)]);
    const missing = await fetch(`${base}/blob/${'d'.repeat(32)}`, as('viewer'));
    assert.deepEqual([missing.status, await missing.text()], [404, '']);
  });

  it('treat a browser that goes away mid-picture as done, not as an error', async () => {
    const chunk = Buffer.alloc(64 * 1024, 1);
    const big = (): PhotoFile => ({
      type: 'image/jpeg',
      bytes: chunk.length * 1000,
      modifiedAt,
      content: (async function* () {
        for (let i = 0; i < 1000; i++) {
          yield chunk;
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })(),
    });
    const routes = photoRoutes({
      identify: () => ({ name: 'justin', role: 'viewer' }),
      uploadPhoto: { execute: async () => assert.fail('not expected to run') },
      deletePhoto: { execute: async () => assert.fail('not expected to run') },
      openPhoto: { execute: async () => big() },
    });
    const outcome = new Promise<string>((resolve) => {
      const server = http.createServer((req, res) => {
        routes.root.handle(req, res).then(
          () => resolve('finished quietly'),
          (error: unknown) => resolve(`failed: ${String(error)}`),
        );
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const req = http.get(`http://127.0.0.1:${address.port}/blob/${id}`, (res) => {
          res.once('data', () => req.destroy());
        });
        req.on('error', () => undefined);
      });
      setTimeout(() => server.close(), 3000).unref();
    });
    assert.equal(await outcome, 'finished quietly');
  });
});
