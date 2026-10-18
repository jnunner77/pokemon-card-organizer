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
  /** Costly to serve (a backup, a restore): the request pipeline applies its stricter rate limit. */
  readonly heavy: boolean;
}

export interface RouteOptions {
  readonly heavy?: boolean;
}

/** What the request pipeline needs of a set of routes. */
export type Routes = Pick<Router, 'owns' | 'isHeavy' | 'handle'>;

const matches = (route: Route, method: string | undefined) => route.method === method || (route.method === 'GET' && method === 'HEAD');

/**
 * A minimal router. Paths match case-insensitively and ignore a trailing slash, like the rest of
 * the API; `:name` matches one path segment.
 */
export class Router {
  readonly #routes: Route[] = [];

  add(method: string, path: string, handler: Handler, options: RouteOptions = {}): this {
    const names: string[] = [];
    const source = path
      .split('/')
      .map((part) => {
        if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(part.slice(1));
        return '([^/]+)';
      })
      .join('/');
    this.#routes.push({ method, pattern: new RegExp(`^${source}/?$`, 'i'), names, handler, heavy: options.heavy === true });
    return this;
  }

  /** Whether a request for this method and path (without a query string) would be handled here. */
  owns(method: string, path: string): boolean {
    return this.#routes.some((r) => matches(r, method) && r.pattern.test(path));
  }

  /** Whether the route for this method and path is a heavy one. */
  isHeavy(method: string, path: string): boolean {
    return this.#routes.some((r) => r.heavy && matches(r, method) && r.pattern.test(path));
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

/** Several sets of routes as one, tried in order. */
export function combine(...routes: readonly Routes[]): Routes {
  return {
    owns: (method, path) => routes.some((r) => r.owns(method, path)),
    isHeavy: (method, path) => routes.some((r) => r.isHeavy(method, path)),
    handle: async (req, res) => {
      for (const r of routes) if (await r.handle(req, res)) return true;
      return false;
    },
  };
}
