import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import type { Caller } from '#application/access.ts';
import type { Identity } from '#application/accounts/identity.ts';
import { err, ok } from '#shared/result.ts';
import { adminRoutes, type AdminRouteDeps } from '#presentation/admin/routes.ts';
import { json, serve } from '../fixtures.ts';

const roleOf = (req: { headers: Record<string, unknown> }) => {
  const role = req.headers['x-role'];
  return role === 'viewer' || role === 'editor' || role === 'admin' ? role : null;
};
const feed = { seenAt: null, errors: 0, warnings: 0, groups: [], latest: null };

async function setUp(over: Partial<AdminRouteDeps> = {}) {
  const asked: unknown[] = [];
  const record = <T>(answer: T) => ({ execute: (input?: unknown) => (asked.push(input), answer) });
  const deps: AdminRouteDeps = {
    identify: (req) => {
      const role = roleOf(req);
      return role ? ({ name: 'justin', role } satisfies Caller) : null;
    },
    identity: (req) => {
      const role = roleOf(req);
      return role ? ({ id: 'u1', name: 'justin', displayName: 'Justin', role, via: 'session' } satisfies Identity) : null;
    },
    client: (req) => ({ ip: String(req.headers['x-ip'] ?? '203.0.113.9'), secure: req.headers['x-secure'] === '1' }),
    guest: (req) => (req.headers['x-guest'] ? ({ id: 'g1' } as never) : null),
    trustsProxy: false,
    overview: { execute: async (input) => (asked.push(input), { checks: [], ledger: { binders: 1, cards: 2, photos: 0, bytes: 0, trashed: 0 }, server: { node: 'v22', uptimeHours: 1, startedAt: 'x' } }) },
    readPriceSettings: record({ available: false, schedule: null, pricecharting: null, running: false, done: 0, total: 0, current: null, problem: null, history: [] }),
    changePriceSchedule: record(ok({ schedule: { enabled: true, hour: 7 } })),
    changePriceMethod: record(err({ code: 'INVALID_SETTING' as const, message: 'Give at least one source a weight.' })),
    savePriceChartingToken: { execute: async (input) => (asked.push(input), err({ code: 'TOKEN_CHECK_FAILED' as const, message: 'timed out' })) },
    removePriceChartingToken: record(err({ code: 'PRICECHARTING_UNAVAILABLE' as const })),
    listProblems: record(feed),
    markProblemsSeen: record(ok(feed)),
    searchLogs: record({ entries: [], files: [] }),
    openLogFile: { execute: async (input) => (asked.push(input), input.name === '2026-10-03.jsonl' ? { bytes: 6, content: (async function* () { yield new TextEncoder().encode('line\n\n'); })() } : null) },
    reportPageError: record(ok(undefined)),
    ...over,
  };
  const routes = adminRoutes(deps);
  return { base: await serve(routes.handle), asked, routes };
}
const as = (role: string, init: RequestInit = {}, headers: Record<string, string> = {}): RequestInit => {
  const h = new Headers(init.headers);
  h.set('X-Role', role);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return { ...init, headers: h };
};
const answer = async (r: Response) => [r.status, await r.json()];

describe('admin routes', () => {
  it('are for administrators only, checked before the request is read', async () => {
    const { base, asked } = await setUp();
    for (const [method, path] of [['GET', '/admin/overview'], ['GET', '/admin/pricing'], ['PUT', '/admin/pricing'], ['PUT', '/admin/pricing/method'], ['PUT', '/admin/pricing/pricecharting-token'], ['DELETE', '/admin/pricing/pricecharting-token'], ['GET', '/admin/problems'], ['POST', '/admin/problems/seen'], ['GET', '/admin/logs'], ['GET', '/admin/logs/files/2026-10-03.jsonl']] as const) {
      const r = await fetch(`${base}${path}`, as('editor', method === 'GET' || method === 'DELETE' ? { method } : json({}, method)));
      assert.deepEqual(await answer(r), [403, { error: 'Only administrators can do this.', code: 'forbidden' }], `${method} ${path}`);
      assert.equal((await fetch(`${base}${path}`, { method })).status, 401);
    }
    assert.deepEqual(asked, []);
  });

  it('serve the overview with who is asking, and what the request says about HTTPS and the proxy', async () => {
    const { base, asked } = await setUp();
    const r = await fetch(`${base}/admin/overview`, as('admin', {}, { 'X-Forwarded-For': '198.51.100.1', 'X-Ip': '::1' }));
    assert.deepEqual(await answer(r), [200, { checks: [], you: { username: 'justin', name: 'Justin' }, ledger: { binders: 1, cards: 2, photos: 0, bytes: 0, trashed: 0 }, server: { node: 'v22', uptimeHours: 1, startedAt: 'x' } }]);
    assert.deepEqual(asked, [{ secure: false, untrustedProxy: true, localRequest: true }]);
    const trusted = await setUp({ trustsProxy: true });
    await fetch(`${trusted.base}/admin/overview`, as('admin', {}, { 'X-Forwarded-For': '198.51.100.1', 'X-Secure': '1' }));
    assert.deepEqual(trusted.asked, [{ secure: true, untrustedProxy: false, localRequest: false }]);
  });

  it('change the schedule and the method, answering 400 with the reason', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/admin/pricing`, as('admin', json({ enabled: true, hour: 7 }, 'PUT')))), [200, { schedule: { enabled: true, hour: 7 } }]);
    assert.deepEqual(asked, [{ actor: 'justin', schedule: { enabled: true, hour: 7 } }]);
    assert.deepEqual(await answer(await fetch(`${base}/admin/pricing/method`, as('admin', json({}, 'PUT')))), [400, { error: 'Give at least one source a weight.', code: 'invalid_argument' }]);
    assert.deepEqual(await answer(await fetch(`${base}/admin/pricing`, as('admin', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":' }))), [400, { error: "The request body isn't valid JSON", code: 'invalid_argument' }]);
  });

  it("save and remove PriceCharting's token, saying why when it can't", async () => {
    const { base, asked, routes } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/admin/pricing/pricecharting-token`, as('admin', json({ token: 'x' }, 'PUT')))), [502, { error: "Couldn't check the token with PriceCharting: timed out. Try again.", code: 'upstream_error' }]);
    assert.deepEqual(asked, [{ actor: 'justin', body: { token: 'x' } }]);
    assert.deepEqual(await answer(await fetch(`${base}/admin/pricing/pricecharting-token`, as('admin', { method: 'DELETE' }))), [400, { error: 'PriceCharting prices are not available on this server.', code: 'invalid_argument' }]);
    // Saving a token asks PriceCharting: the heavy rate limit applies, to administrators only.
    assert.deepEqual(routes.heavyLimit('PUT', '/admin/pricing/pricecharting-token'), { role: 'admin' });
    assert.equal(routes.heavyLimit('GET', '/admin/pricing'), null);
  });

  it('list problems (all with ?all=1) and mark them seen', async () => {
    const { base, asked } = await setUp();
    await fetch(`${base}/admin/problems?all=1`, as('admin'));
    await fetch(`${base}/admin/problems?all=1&all=1`, as('admin'));
    await fetch(`${base}/admin/problems`, as('admin'));
    assert.deepEqual(asked, [{ all: true }, { all: false }, { all: false }]);
    assert.deepEqual(await answer(await fetch(`${base}/admin/problems/seen`, as('admin', json({ upTo: '2026-10-03T12:00:00.000Z' })))), [200, feed]);
    assert.deepEqual(asked.at(-1), { body: { upTo: '2026-10-03T12:00:00.000Z' } });
    await fetch(`${base}/admin/problems/seen`, as('admin', { method: 'POST' }));
    assert.deepEqual(asked.at(-1), { body: undefined });
  });

  it('search the logs and download a day’s file', async () => {
    const { base, asked } = await setUp();
    assert.deepEqual(await answer(await fetch(`${base}/admin/logs?cat=auth&q=sign&limit=5&level=warn&before=9`, as('admin'))), [200, { entries: [], files: [] }]);
    assert.deepEqual(asked, [{ cat: 'auth', text: 'sign', limit: 5, level: 'warn', before: 9 }]);
    await fetch(`${base}/admin/logs?q=a?b`, as('admin'));
    assert.deepEqual(asked.at(-1), { text: 'a?b' });
    assert.deepEqual(await answer(await fetch(`${base}/admin/logs?level=nonsense`, as('admin'))), [400, { error: 'Invalid option: expected one of "info"|"warn"|"error"', code: 'invalid_argument' }]);
    assert.deepEqual(await answer(await fetch(`${base}/admin/logs?limit=1001`, as('admin'))), [400, { error: 'Too big: expected number to be <=1000', code: 'invalid_argument' }]);
    const file = await fetch(`${base}/admin/logs/files/2026-10-03.jsonl`, as('admin'));
    assert.deepEqual([file.status, file.headers.get('content-type'), file.headers.get('content-disposition'), await file.text()], [200, 'text/plain; charset=utf-8', 'attachment; filename="binder-log-2026-10-03.jsonl"', 'line\n\n']);
    assert.deepEqual(await answer(await fetch(`${base}/admin/logs/files/..%2Fauth.json`, as('admin'))), [404, { error: 'No such log file', code: 'not_found' }]);
    assert.deepEqual(asked.at(-1), { name: '../auth.json' });
  });

  it('close the log file on a HEAD request, and take a cancelled download as no error', async () => {
    const files: Readable[] = [];
    const open = { execute: async () => { const r = new Readable({ read() {} }); r.push('first line\n'); files.push(r); return { bytes: 1_000_000, content: r }; } };
    const head = await setUp({ openLogFile: open });
    const r = await fetch(`${head.base}/admin/logs/files/2026-10-03.jsonl`, as('admin', { method: 'HEAD' }));
    assert.deepEqual([r.status, r.headers.get('content-length')], [200, '1000000']);
    assert.equal(files[0]?.destroyed, true);

    const { routes } = await setUp({ openLogFile: open });
    const failures: unknown[] = [];
    const served = new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => void routes.handle(req, res).then(() => resolve(), (error: unknown) => (failures.push(error), resolve())));
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const req = http.get({ port: address.port, host: '127.0.0.1', path: '/admin/logs/files/2026-10-03.jsonl', headers: { 'X-Role': 'admin' } }, (res) => res.once('data', () => req.destroy()));
        req.on('error', () => {});
      });
      after(() => new Promise<void>((done) => server.close(() => done())));
    });
    await served;
    assert.deepEqual(failures, []);
    assert.equal(files[1]?.destroyed, true);
  });

  it('take page errors from anyone signed in, and from signed-in guests', async () => {
    const { base, asked } = await setUp();
    assert.equal((await fetch(`${base}/client-error`, json({ message: 'x' }))).status, 401);
    assert.equal((await fetch(`${base}/client-error`, as('viewer', json({ message: 'boom' })))).status, 204);
    assert.deepEqual(asked, [{ report: { message: 'boom' }, by: { user: 'justin' } }]);
    assert.deepEqual(await answer(await fetch(`${base}/client-error`, as('viewer', json({ message: 'y'.repeat(20_000) })))), [413, { error: 'That upload is too large', code: 'too_large' }]);
    assert.deepEqual(await answer(await fetch(`${base}/guest/client-error`, json({ message: 'x' }))), [401, { error: 'Please sign in', code: 'signin' }]);
    assert.equal((await fetch(`${base}/guest/client-error`, { ...json({ message: 'g' }), headers: { 'Content-Type': 'application/json', 'X-Guest': '1' } })).status, 204);
    assert.deepEqual(asked.at(-1), { report: { message: 'g' }, by: { guest: true } });
    const refused = await setUp({ reportPageError: { execute: () => err({ code: 'INVALID_PAGE_ERROR' as const, message: 'Too big: expected string to have <=500 characters' }) } });
    assert.deepEqual(await answer(await fetch(`${refused.base}/client-error`, as('viewer', json({ message: 'z' })))), [400, { error: 'Too big: expected string to have <=500 characters', code: 'invalid_argument' }]);
    // Without guest viewing there is no guest error route.
    const noGuests = await setUp({ guest: null });
    assert.equal(noGuests.routes.owns('POST', '/guest/client-error'), false);
  });
});
