import type { IncomingMessage, ServerResponse } from 'node:http';

/** Handles a request it recognises and returns true, or returns false to let the next handler try. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type Params = Readonly<Record<string, string>>;
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params) => Promise<void>;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly names: readonly string[];
  readonly handler: Handler;
}

const matches = (route: Route, method: string | undefined) => route.method === method || (route.method === 'GET' && method === 'HEAD');

/**
 * A minimal router. Paths match case-insensitively and ignore a trailing slash, like the rest of
 * the API; `:name` matches one path segment.
 */
export class Router {
  readonly #routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const names: string[] = [];
    const source = path
      .split('/')
      .map((part) => {
        if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(part.slice(1));
        return '([^/]+)';
      })
      .join('/');
    this.#routes.push({ method, pattern: new RegExp(`^${source}/?$`, 'i'), names, handler });
    return this;
  }

  /** Whether a request for this method and path (without a query string) would be handled here. */
  owns(method: string, path: string): boolean {
    return this.#routes.some((r) => matches(r, method) && r.pattern.test(path));
  }

  readonly handle: RouteHandler = async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    for (const route of this.#routes) {
      if (!matches(route, req.method)) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [i, name] of route.names.entries()) {
        const raw = match[i + 1] ?? '';
        try {
          params[name] = decodeURIComponent(raw);
        } catch {
          params[name] = raw;
        }
      }
      await route.handler(req, res, params);
      return true;
    }
    return false;
  };
}
