import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Caller } from '#application/access.ts';
import { err, ok } from '#shared/result.ts';
import { alertRoutes, type AlertRouteDeps } from '#presentation/alerts/routes.ts';
import { body, json, serve } from '../fixtures.ts';

const VIEW = { settings: null, password: { set: false, savedAt: null }, watching: { buy: 0, sell: 0 }, lastSent: null, lastError: null };

async function setUp(over: Partial<AlertRouteDeps> = {}) {
  const asked: unknown[] = [];
  const deps: AlertRouteDeps = {
    identify: (req) => {
      const role = req.headers['x-role'];
      return role === 'viewer' || role === 'editor' || role === 'admin' ? ({ name: 'justin', role } satisfies Caller) : null;
    },
    readAlertSettings: { execute: async () => VIEW },
    saveAlertSettings: { execute: async (input) => (asked.push(input), err({ code: 'MAIL_REFUSED' as const, message: '535 not accepted' })) },
    removeAlertSettings: { execute: async (input) => (asked.push(input), VIEW) },
    sendTestAlert: { execute: async (input) => (asked.push(input), ok({ to: ['me@gmail.com'] })) },
    ...over,
  };
  return { base: await serve(alertRoutes(deps).handle), asked };
}
const as = (role: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), 'X-Role': role } });

describe('alert routes', () => {
  it('are for administrators only, checked before the request is read', async () => {
    const { base, asked } = await setUp();
    for (const [method, path] of [['GET', '/admin/alerts'], ['PUT', '/admin/alerts'], ['DELETE', '/admin/alerts'], ['POST', '/admin/alerts/test']] as const) {
      const r = await fetch(`${base}${path}`, as('editor', method === 'PUT' ? json({}, method) : { method }));
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal((await fetch(`${base}${path}`, { method })).status, 401);
    }
    assert.deepEqual(asked, []);
  });

  it('read, save, test and remove the settings', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await (await fetch(`${base}/admin/alerts`, as('admin'))).json(), VIEW);
    const saved = await fetch(`${base}/admin/alerts`, as('admin', json({ gmail: 'me@gmail.com' }, 'PUT')));
    assert.equal(saved.status, 400);
    assert.match((await body(saved)).error, /Gmail didn't accept that address and app password \(535 not accepted\)/);
    assert.deepEqual(asked[0], { actor: 'justin', body: { gmail: 'me@gmail.com' } });
    const test = await fetch(`${base}/admin/alerts/test`, as('admin', { method: 'POST' }));
    assert.deepEqual([test.status, await test.json()], [200, { to: ['me@gmail.com'] }]);
    const off = await fetch(`${base}/admin/alerts`, as('admin', { method: 'DELETE' }));
    assert.equal(off.status, 200);
  });

  it('say a send that failed is Gmail\'s problem (502)', async () => {
    const { base } = await setUp({ sendTestAlert: { execute: async () => err({ code: 'MAIL_FAILED' as const, message: 'ETIMEDOUT' }) } });
    const r = await fetch(`${base}/admin/alerts/test`, as('admin', { method: 'POST' }));
    assert.equal(r.status, 502);
    assert.match((await body(r)).error, /Couldn't send the email through Gmail: ETIMEDOUT/);
  });
});
