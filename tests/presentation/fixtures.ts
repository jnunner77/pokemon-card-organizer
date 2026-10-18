import assert from 'node:assert/strict';
import http from 'node:http';
import { after } from 'node:test';
import type { RouteHandler } from '#presentation/http/router.ts';

/** Serve a route handler on a free port (404 for what it doesn't handle); its base URL. */
export async function serve(handle: RouteHandler): Promise<string> {
  const server = http.createServer((req, res) => {
    handle(req, res).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      (error: unknown) => res.writeHead(500).end(String(error)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

export const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A JSON answer read loosely, for tests that pick fields out of it. */
export const body = async (r: Response): Promise<any> => r.json();
