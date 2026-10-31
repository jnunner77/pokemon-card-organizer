import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/runtime.js is the page's storage layer; load it with a fake browser and call the API the way the page does.
type Api = { call(method: string, url: string, body?: unknown): Promise<unknown> };
function load(answer: { status: number; headers?: Record<string, string>; body?: unknown }): Api {
  const response = {
    ok: answer.status < 400,
    status: answer.status,
    statusText: 'Too Many Requests',
    headers: { get: (name: string) => answer.headers?.[name] ?? null },
    json: async () => answer.body ?? {},
  };
  const window: Record<string, unknown> = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/runtime.js'), 'utf8'), { window, fetch: async () => response, location: { assign() {} }, console });
  return window['ledgerApi'] as Api;
}
const rejection = async (api: Api) => api.call('PATCH', 'api/docs/cards/c1', {}).then(() => null, (e: Error & { code?: string; retryAfter?: number }) => e);

describe('the page\'s API calls', () => {
  it('carries how long to wait from a Retry-After header', async () => {
    const e = await rejection(load({ status: 429, headers: { 'Retry-After': '3' }, body: { error: 'Too many changes' } }));
    expect(e?.code).toBe('rate_limited');
    expect(e?.retryAfter).toBe(3);
  });

  it('leaves it unset without a usable Retry-After', async () => {
    for (const headers of [{}, { 'Retry-After': 'soon' }, { 'Retry-After': '0' }] as Record<string, string>[]) {
      const e = await rejection(load({ status: 429, headers, body: { error: 'Too many changes' } }));
      expect(e?.code).toBe('rate_limited');
      expect(e && 'retryAfter' in e).toBe(false);
    }
  });
});
