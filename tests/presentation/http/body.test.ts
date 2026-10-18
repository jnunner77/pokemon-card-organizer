import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readJsonBody } from '#presentation/http/body.ts';
import { sendJson } from '#presentation/http/respond.ts';
import { serve } from '../fixtures.ts';

describe('readJsonBody', async () => {
  const base = await serve(async (req, res) => {
    sendJson(res, 200, await readJsonBody(req, 64));
    return true;
  });
  const send = async (body: string, type = 'application/json') => (await fetch(base, { method: 'POST', headers: { 'Content-Type': type }, body })).json();

  it('reads objects and lists; an empty body is {}', async () => {
    assert.deepEqual(await send('{"a":1}'), { ok: true, value: { a: 1 } });
    assert.deepEqual(await send('[1,2]'), { ok: true, value: [1, 2] });
    assert.deepEqual(await send(''), { ok: true, value: {} });
    assert.deepEqual(await send('{"a":1}', 'application/json; charset=utf-8'), { ok: true, value: { a: 1 } });
  });

  it('has no body unless it is JSON', async () => {
    assert.deepEqual(await send('{"a":1}', 'text/plain'), { ok: true });
  });

  it('refuses what is not a JSON object or list, and bodies over the limit', async () => {
    assert.deepEqual(await send('"text"'), { ok: false, error: { code: 'MALFORMED_JSON' } });
    assert.deepEqual(await send('{"a":'), { ok: false, error: { code: 'MALFORMED_JSON' } });
    assert.deepEqual(await send(JSON.stringify({ a: 'x'.repeat(100) })), { ok: false, error: { code: 'BODY_TOO_LARGE' } });
  });
});
