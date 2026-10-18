import assert from 'node:assert/strict';
import net from 'node:net';
import zlib from 'node:zlib';
import { describe, it } from 'node:test';
import { readJsonBody } from '#presentation/http/body.ts';
import { sendJson } from '#presentation/http/respond.ts';
import { serve } from '../fixtures.ts';

describe('readJsonBody', async () => {
  const base = await serve(async (req, res) => {
    sendJson(res, 200, await readJsonBody(req, 64));
    return true;
  });
  const send = async (body: string | Buffer, type = 'application/json', encoding?: string) =>
    (await fetch(base, { method: 'POST', headers: { 'Content-Type': type, ...(encoding ? { 'Content-Encoding': encoding } : {}) }, body })).json();

  it('reads objects and lists; an empty body is {}', async () => {
    assert.deepEqual(await send('{"a":1}'), { ok: true, value: { a: 1 } });
    assert.deepEqual(await send('[1,2]'), { ok: true, value: [1, 2] });
    assert.deepEqual(await send(''), { ok: true, value: {} });
    assert.deepEqual(await send('{"a":1}', 'application/json; charset=utf-8'), { ok: true, value: { a: 1 } });
  });

  it('has no body unless it is JSON', async () => {
    assert.deepEqual(await send('{"a":1}', 'text/plain'), { ok: true });
  });

  it('has no body when the request announces none, even typed as JSON', async () => {
    const { hostname, port } = new URL(base);
    const answer = await new Promise<string>((resolve, reject) => {
      // No Content-Length and no Transfer-Encoding: a request with no body at all.
      const socket = net.connect(Number(port), hostname, () => socket.end(`PUT / HTTP/1.1\r\nHost: ${hostname}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`));
      let text = '';
      socket.on('data', (chunk) => (text += String(chunk)));
      socket.on('end', () => resolve(text.slice(text.indexOf('\r\n\r\n') + 4)));
      socket.on('error', reject);
    });
    assert.deepEqual(JSON.parse(answer), { ok: true });
  });

  it('refuses what is not a JSON object or list, and bodies over the limit', async () => {
    assert.deepEqual(await send('"text"'), { ok: false, error: { code: 'MALFORMED_JSON' } });
    assert.deepEqual(await send('{"a":'), { ok: false, error: { code: 'MALFORMED_JSON' } });
    assert.deepEqual(await send(JSON.stringify({ a: 'x'.repeat(100) })), { ok: false, error: { code: 'BODY_TOO_LARGE' } });
  });

  it('refuses a body of whitespace alone: only a body of no bytes is {}', async () => {
    assert.deepEqual(await send('   \n'), { ok: false, error: { code: 'MALFORMED_JSON' } });
  });

  it('decompresses gzip, deflate and Brotli bodies, with the limit on what they decompress to', async () => {
    const json = Buffer.from('{"a":1}');
    assert.deepEqual(await send(zlib.gzipSync(json), 'application/json', 'gzip'), { ok: true, value: { a: 1 } });
    assert.deepEqual(await send(zlib.deflateSync(json), 'application/json', 'deflate'), { ok: true, value: { a: 1 } });
    assert.deepEqual(await send(zlib.brotliCompressSync(json), 'application/json', 'br'), { ok: true, value: { a: 1 } });
    assert.deepEqual(await send(zlib.gzipSync(JSON.stringify({ a: 'x'.repeat(1000) })), 'application/json', 'gzip'), { ok: false, error: { code: 'BODY_TOO_LARGE' } });
  });

  it('refuses compressed data that does not decompress, and encodings it cannot read', async () => {
    assert.deepEqual(await send('not gzip', 'application/json', 'gzip'), { ok: false, error: { code: 'MALFORMED_JSON' } });
    assert.deepEqual(await send('{"a":1}', 'application/json', 'compress'), { ok: false, error: { code: 'UNSUPPORTED_ENCODING', encoding: 'compress' } });
  });
});
