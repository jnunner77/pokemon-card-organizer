import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { exemptFromRateLimits, requireRole } from '#application/access.ts';
import type { TokenVault } from '#application/admin/ports.ts';
import type { IdentifyCaller } from '#application/accounts/identify-caller.ts';
import type { Identity } from '#application/accounts/identity.ts';
import type { IdentifyGuest } from '#application/guests/identify-guest.ts';
import type { SignedInGuest } from '#application/guests/state.ts';
import { atLeast, type Role } from '#domain/accounts/role.ts';
import type { ServerLog } from '#application/logging.ts';
import type { TakeSnapshot } from '#application/backups/take-snapshot.ts';
import { SESSION_COOKIE } from '#presentation/accounts/routes.ts';
import { GUEST_COOKIE, type GuestResolver } from '#presentation/guests/routes.ts';
import type { CallerResolver, IdentityResolver } from '#presentation/http/caller.ts';
import type { ClientInfo, ClientResolver } from '#presentation/http/client.ts';
import { readCookie } from '#presentation/http/cookies.ts';
import type { Routes } from '#presentation/http/router.ts';
import type { StreamGate } from '#presentation/http/streams.ts';
import { z } from 'zod';
import { quietLogger } from '#infrastructure/logging/logger.ts';
import type { PriceCharting } from './pricing/pricecharting.ts';
import { SourceError } from './pricing/sources.ts';
import type { PriceUpdater, RunProblem, RunSummary } from './pricing/updater.ts';
import { InvalidDoc, idSchema } from './schema.ts';
import { HttpError, MUTATING, type Security } from './security.ts';
import { NotFound, SaveFailed, type Store } from '#infrastructure/json-store/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Routes served by the layered code (src/): those under /api (relative to it), and the rest (/blob). */
export interface LayeredRoutes {
  readonly api: Routes;
  readonly root: Routes;
}

/** What the Express code still asks of the backups (the daily price rebuild's copy). */
export interface ExpressBackups {
  readonly takeSnapshot: Pick<TakeSnapshot, 'execute'>;
}

/** What the layered routes learn from Express about a request: who is calling, which guest, where from, and its live-update limit. */
export interface LayeredContext {
  readonly identify: CallerResolver;
  readonly identity: IdentityResolver;
  readonly guest: GuestResolver;
  readonly client: ClientResolver;
  readonly streams: StreamGate;
}

/** Who is calling, worked out by the layered code (src/application/accounts and guests). */
export interface ExpressPeople {
  readonly identifyCaller: Pick<IdentifyCaller, 'execute'>;
  /** Null when this server has no guest viewing. */
  readonly identifyGuest: Pick<IdentifyGuest, 'execute'> | null;
}

export interface AppOptions {
  store: Store;
  /** Builds the layered routes, given what Express knows about each request. */
  layeredRoutes: (context: LayeredContext) => LayeredRoutes;
  people: ExpressPeople;
  /** The pages, styles and scripts. Defaults to ./public. */
  publicDir?: string | undefined;
  trustProxy?: boolean | number | string | undefined;
  /** Daily price and image updates; the pricing routes answer 503 without one. */
  updater?: PriceUpdater | undefined;
  /** Rate limits and blocks; off when not given. */
  security?: Security | undefined;
  log?: ServerLog | undefined;
  backups: ExpressBackups;
  /** The clock for the price update's log (tests set it; defaults to the real time). */
  now?: (() => Date) | undefined;
  /** PriceCharting's API token (its own secret file, outside the data that's backed up) and its client. */
  pricecharting?: { token: TokenVault; api: PriceCharting } | undefined;
}

/**
 * Anyone may load these: the sign-in page and what it needs, and the guest page (whose API checks
 * for a signed-in guest itself).
 */
const PUBLIC = [/^\/login\.(html|js)$/, /^\/styles\.css$/, /^\/icon\.svg$/, /^\/fonts\//, /^\/api\/(health|auth\/(me|login|logout|password|setup))$/, /^\/guest\.(html|js)$/, /^\/(search|back)\.js$/, /^\/api\/guest\//];
const PAGES = new Set(['/', '/index.html', '/admin.html']);

export function createExpressApp(o: AppOptions) {
  const { store, publicDir = path.join(root, 'public'), trustProxy, updater, security, people } = o;
  const log = o.log ?? quietLogger();
  const now = o.now ?? (() => new Date());
  const { backups } = o;

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

  // ---- every request ------------------------------------------------------------------
  app.use(requestLog(log));
  app.use(securityHeaders);
  // A guest from the QR code, if any, before the firewall so they get a guest's limits. Their page's
  // twice-a-minute check (GET /api/guest/me) and live updates (GET /api/guest/events) don't count as
  // using it, so idle guests still time out.
  const identifyGuest = people.identifyGuest;
  if (identifyGuest) {
    const quiet = new Set(['/api/guest/me', '/api/guest/events']);
    app.use(async (req, res, next) => {
      const token = readCookie(req, GUEST_COOKIE);
      if (token) res.locals.guest = (await identifyGuest.execute({ token, touch: !(req.method === 'GET' && quiet.has(req.path)) })) ?? undefined;
      next();
    });
  }
  // Who is calling: a session cookie, an API token, or (without accounts) the local owner. Identified
  // before the firewall so signed-in administrators aren't rate limited or blocked.
  const credentials = (req: Request) => ({ sessionToken: readCookie(req, SESSION_COOKIE), bearer: /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1] });
  app.use(async (req, res, next) => {
    const { identity, badToken } = await people.identifyCaller.execute(credentials(req));
    res.locals.caller = identity ?? undefined;
    // The rate limits count by the person's id.
    res.locals.user = identity ?? undefined;
    res.locals.unlimited = exemptFromRateLimits(identity);
    res.locals.badToken = badToken;
    next();
  });
  if (security) app.use(security.firewall);
  // A bad API token is refused after the firewall, so it still counts against its address.
  app.use((_req, res, next) => {
    if (res.locals.badToken === true) return void res.status(401).json({ error: 'Invalid or expired API token', code: 'token' });
    next();
  });

  // Signed-out visitors get the sign-in page; everything with data needs a session or token. Routes
  // match whatever the address's case ("/BLOB/…" is "/blob/…"), so the checks do too.
  app.use((req, res, next) => {
    const caller = res.locals.caller as Identity | undefined;
    const at = req.path.toLowerCase();
    if (PUBLIC.some((p) => p.test(at))) return next();
    if (PAGES.has(at) && req.method === 'GET') {
      if (!caller) return void res.redirect(302, 'login.html');
      if (at === '/admin.html' && !atLeast(caller.role, 'admin')) return void res.redirect(302, './');
      return next();
    }
    if ((at.startsWith('/api/') || at.startsWith('/blob/')) && !caller) {
      return void res.status(401).json({ error: 'Please sign in', code: 'signin' });
    }
    next();
  });

  const need = (role: Role) => (_req: Request, res: Response, next: NextFunction) => {
    const caller = res.locals.caller as Identity | undefined;
    if (!caller) throw new HttpError(401, 'Please sign in', 'signin');
    if (!atLeast(caller.role, role)) throw new HttpError(403, role === 'admin' ? 'Only administrators can do this.' : 'You have view-only access.', 'forbidden');
    next();
  };
  // Requests the layered code serves: who is calling and which guest come from Express
  // (res.locals), as do the client's address and HTTPS (behind a trusted proxy), the live-update
  // connection limit, and the heavy rate limit for the routes that ask for it.
  interface Seen {
    readonly req: Request;
    readonly res: Response;
    readonly identity: Identity | null;
    readonly guest: SignedInGuest | null;
    readonly client: ClientInfo;
  }
  const seen = new WeakMap<object, Seen>();
  const layered = o.layeredRoutes({
    identify: (req) => seen.get(req)?.identity ?? null,
    identity: (req) => seen.get(req)?.identity ?? null,
    guest: (req) => seen.get(req)?.guest ?? null,
    client: (req) => seen.get(req)?.client ?? { ip: req.socket.remoteAddress ?? '', secure: false },
    streams: (req, _res, key) => {
      const s = seen.get(req);
      if (!security || !s) return { release: () => {} };
      try {
        return { release: security.openStream(s.req, s.res, key) };
      } catch (err) {
        if (err instanceof HttpError) return { refused: { status: err.status, code: err.code, message: err.message, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) } };
        throw err;
      }
    },
  });
  const bridge = (routes: Routes) => (req: Request, res: Response, next: NextFunction) => {
    if (!routes.owns(req.method, req.path)) return next();
    const caller = res.locals.caller as Identity | undefined;
    seen.set(req, { req, res, identity: caller ?? null, guest: (res.locals.guest as SignedInGuest | undefined) ?? null, client: { ip: req.ip ?? '', secure: req.secure } });
    const serve = (err?: unknown) => {
      if (err) return next(err);
      routes.handle(req, res).then((handled) => {
        if (!handled) next();
      }, next);
    };
    // The heavy limit counts only callers the route will serve: anyone else is refused (401/403) first.
    const heavy = routes.heavyLimit(req.method, req.path);
    const served = heavy !== null && requireRole(caller ?? null, heavy.role).ok;
    if (!security || !served) return serve();
    try {
      security.heavy(req, res, serve);
    } catch (err) {
      next(err);
    }
  };
  const who = (res: Response) => (res.locals.caller as Identity | undefined)?.name ?? 'someone';
  const heavy = security ? security.heavy : (_req: Request, _res: Response, next: NextFunction) => next();
  const json = express.json({ limit: '1mb' });

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  api.use(sameOrigin);
  if (security) {
    api.use(security.apiLimits);
    api.use(['/auth/login', '/auth/password', '/auth/setup'], security.signIn);
  }

  // ---- served by the layered code ------------------------------------------------------
  // In src/presentation: signing in and out, the guest page, people,
  // sessions, API tokens and guests under Administration, the ledger itself, sorting binders and
  // moving cards, photos, full backups and the kept copies, Administration's overview, price
  // settings, PriceCharting token, problems and logs, the pages' error reports, card details from
  // the card database, Find a card → Any card, and master sets. Express still runs the request
  // pipeline (it asks the layered code who is calling, and applies the rate limits, heavy ones for
  // backups, restores, Fill in missing details and master sets); the routes check what the caller
  // may do.
  api.use(bridge(layered.api));

  // Live updates: every change is pushed to every open page, until the session ends.
  api.get('/events', need('viewer'), (req, res) => {
    const release = security ? security.openStream(req, res) : () => {};
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('event: hello\ndata: {}\n\n');
    const sent = credentials(req);
    // Writes go out one at a time and in order, each after checking the session or token still works.
    let queue = Promise.resolve();
    const whileAllowed = (write: () => void) => {
      queue = queue.then(async () => {
        try {
          if ((await people.identifyCaller.execute(sent)).identity) write();
          else stop();
        } catch {
          stop();
        }
      });
    };
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe();
      release();
      res.end();
    };
    const unsubscribe = store.subscribe((e) => whileAllowed(() => res.write(`data: ${JSON.stringify(e)}\n\n`)));
    // A connection that broke is closed (the page reconnects), never left to throw.
    const heartbeat = setInterval(() => whileAllowed(() => res.write(': ping\n\n')), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      release();
    });
  });

  // ---- automatic prices and images ------------------------------------------------------
  const needUpdater = () => {
    if (!updater) throw new HttpError(503, 'Automatic pricing is turned off on this server', 'unavailable');
    return updater;
  };
  const cardFor = (id: unknown) => {
    const parsed = idSchema.safeParse(id);
    const card = parsed.success ? store.get('cards', parsed.data) : undefined;
    if (!card) throw new HttpError(404, 'No such card', 'not_found');
    return { id: parsed.data!, card };
  };
  // Update every card now: everything (the default), only prices, or only pictures. `force` asks the
  // card databases again even about cards they were asked about this week (Update all cards).
  const runBody = z.object({ scope: z.enum(['all', 'prices', 'pictures']).optional(), force: z.boolean().optional() }).strict();
  api.post('/pricing/run', need('editor'), heavy, json, (req, res) => {
    const u = needUpdater();
    const body = runBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Choose what to update: all, prices or pictures.');
    const scope = body.data.scope ?? 'all';
    const already = u.running;
    u.runAll('manual', scope, !!body.data.force).catch((err) => log.error('pricing', `Update failed: ${err instanceof Error ? err.message : err}`));
    if (!already) log.info('pricing', `${who(res)} started ${scope === 'pictures' ? 'a picture update' : scope === 'prices' ? 'a price update (prices only)' : 'a price update'}${body.data.force ? ', asking the card databases again' : ''}`);
    res.status(202).json({ started: !already, scope: u.runningScope });
  });
  // Stop a running update (one that's stuck, say): another can start straight away.
  api.post('/pricing/stop', need('editor'), (_req, res) => {
    res.json({ stopped: needUpdater().stop(who(res)) });
  });
  // Hide the banner about an update that was interrupted, stalled or failed.
  api.post('/pricing/dismiss', need('editor'), (_req, res) => {
    needUpdater().dismiss();
    log.info('pricing', `${who(res)} dismissed the price update problem`);
    res.status(204).end();
  });
  // The log of the update with a problem (or the running one, or the last one): the pricing and
  // server lines from its start until the problem was noticed, read from the daily files so it
  // survives a restart or crash.
  api.get('/pricing/log', need('editor'), (_req, res) => {
    const st = (store.get('settings', 'pricing') ?? {}) as { running?: boolean; startedAt?: string; problem?: RunProblem | null; lastRun?: RunSummary | null };
    const p = st.problem;
    const nowIso = now().toISOString();
    const minute = 60_000;
    const back = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();
    const ahead = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
    const [from, to] = p
      ? // until a later update started, or now
        [back(p.startedAt ?? back(p.at, 60 * minute), minute), st.startedAt && p.startedAt && st.startedAt > p.startedAt ? st.startedAt : nowIso]
      : st.running && st.startedAt
        ? [back(st.startedAt, minute), nowIso]
        : st.lastRun
          ? [back(st.lastRun.startedAt, minute), ahead(st.lastRun.finishedAt, minute)]
          : [back(nowIso, 60 * minute), nowIso];
    res.json({ from, to, entries: log.between(from, to, { cats: ['pricing', 'app'], limit: 400 }) });
  });
  api.get('/pricing/search', need('editor'), heavy, async (req, res) => {
    const { card } = cardFor(req.query.card);
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : undefined;
    res.json({ candidates: await needUpdater().search(card, q) });
  });
  const linkSchema = z.union([
    z.object({ source: z.enum(['off', 'auto']) }),
    // Stop (or start again) using the card's other price site.
    z.object({ pair: z.enum(['off', 'auto']) }),
    z.object({ source: z.enum(['pricecharting', 'tcgplayer']), id: z.string().min(1).max(300), url: z.string().max(500).optional(), title: z.string().max(300).optional(), set: z.string().max(200).optional() }),
  ]);
  api.post('/pricing/link/:id', need('editor'), json, async (req, res) => {
    const { id, card } = cardFor(req.params.id);
    const choice = linkSchema.safeParse(req.body);
    if (!choice.success) throw new HttpError(400, choice.error.issues[0].message);
    const c = choice.data;
    const linked = card.pricing as { source?: string; id?: string } | null | undefined;
    if ('pair' in c && !((linked?.source === 'pricecharting' || linked?.source === 'tcgplayer') && linked.id)) throw new HttpError(400, 'Match the card on one price site first.');
    const outcome = await needUpdater().link(id, 'id' in c ? { source: c.source, id: c.id, url: c.url ?? '', title: c.title ?? '', set: c.set ?? '' } : c);
    res.json({ outcome, card: { id, ...store.get('cards', id) } });
  });
  api.post('/pricing/refresh/:id', need('editor'), async (req, res) => {
    const { id } = cardFor(req.params.id);
    const outcome = await needUpdater().updateCard(id);
    // Update now: the card's new price is checked against its watches straight away.
    if (outcome === 'updated') needUpdater().pricesChanged();
    res.json({ outcome, card: { id, ...store.get('cards', id) } });
  });

  // ---- administration ------------------------------------------------------------------
  const admin = express.Router();
  admin.use(need('admin'));

  // Past daily prices worked out again with that method: a preview, or (apply) saved after a copy of the ledger.
  admin.post('/pricing/rebuild', heavy, json, async (req, res) => {
    if (!updater) throw new HttpError(400, 'Automatic prices are not available on this server.');
    const apply = req.body?.apply === true;
    let summary;
    try {
      // The copy is taken first, and only when the rebuild will save something (the preview says
      // what would change) and no price update is running (then the rebuild is refused).
      const willSave = apply && !updater.running && updater.rebuildPrices(false).cards > 0;
      const copy = willSave ? (await backups.takeSnapshot.execute({ actor: who(res), label: 'before rebuilding daily prices' })).name : null;
      summary = updater.rebuildPrices(apply, () => copy);
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err), 'busy');
    }
    if (apply) log.info('admin', `${who(res)} rebuilt the past daily prices`, { cards: summary.cards, prices: summary.prices });
    res.json(summary);
  });
  const needPc = () => {
    if (!o.pricecharting || !updater) throw new HttpError(400, 'PriceCharting prices are not available on this server.');
    return o.pricecharting;
  };
  // The subscription ended: the token and everything from PriceCharting go, as its terms ask.
  admin.post('/pricing/purge-pricecharting', heavy, (_req, res) => {
    const pc = needPc();
    let summary;
    try {
      summary = updater!.purgePriceCharting(() => {
        pc.token.clear();
        pc.api.forget();
      });
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err), 'busy');
    }
    log.info('admin', `${who(res)} purged PriceCharting's data and removed its token`, summary);
    res.json({ ...summary, pricecharting: pc.token.info() });
  });

  // Security
  admin.get('/security', (_req, res) => {
    res.json({ enabled: !!security, ...(security?.summary() ?? {}), events: log.query({ cat: 'security', limit: 100 }) });
  });
  admin.delete('/security/bans/:ip', (req, res) => {
    const ok = security?.unban(String(req.params.ip)) ?? false;
    log.info('admin', `${who(res)} unblocked ${req.params.ip}`);
    res.json({ unblocked: ok });
  });

  api.use('/admin', admin);

  api.use((_req, _res) => {
    throw new HttpError(404, 'Not found', 'not_found');
  });
  app.use('/api', api);

  // Photos (/blob/:id), served by the layered code.
  app.use(bridge(layered.root));

  // Fonts are served from their npm packages so the pages need nothing from other sites.
  const fontOpts = { immutable: true, maxAge: '365d', index: false } as const;
  app.use('/fonts/archivo', express.static(path.join(root, 'node_modules/@fontsource-variable/archivo'), fontOpts));
  app.use('/fonts/jetbrains-mono', express.static(path.join(root, 'node_modules/@fontsource/jetbrains-mono'), fontOpts));
  // Pages and scripts change with each release, so browsers check for a newer copy every time.
  app.use(express.static(publicDir, { index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; message?: string };
    let status = 500;
    let code = 'internal';
    let message = 'Something went wrong on the server';
    if (err instanceof HttpError) {
      ({ status, code, message } = err);
      if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    } else if (err instanceof z.ZodError) [status, message] = [400, err.issues[0]?.message ?? 'Invalid request'];
    else if (err instanceof InvalidDoc) [status, message] = [400, err.message];
    else if (err instanceof SourceError) [status, code, message] = [502, 'upstream_error', err.message];
    else if (err instanceof NotFound) [status, code, message] = [404, 'not_found', err.message];
    else if (err instanceof SaveFailed) {
      // The disk is full or can't be written: nothing was changed, and it shows in the problems banner.
      [status, code, message] = [503, 'save_failed', err.message];
      log.error('app', `${req.method} ${req.path}: ${err.message}`);
    }
    else if (e?.type === 'entity.too.large') [status, code, message] = [413, 'too_large', 'That upload is too large'];
    else if (e?.type === 'entity.parse.failed') [status, message] = [400, "The request body isn't valid JSON"];
    else log.error('app', `${req.method} ${req.path} failed: ${e?.message ?? err}`, { stack: (err as Error)?.stack?.split('\n').slice(0, 6).join(' | ') });
    if (status === 400 && code === 'internal') code = 'invalid_argument';
    if (res.headersSent) return void res.end();
    res.status(status).json({ error: message, code });
  });
  return app;
}

/** Log API requests, failures and slow requests (pictures and page files only when they fail). */
function requestLog(log: ServerLog) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const id = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', id);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const isApi = req.path.startsWith('/api/') && req.path !== '/api/health' && req.path !== '/api/events';
      if (!isApi && res.statusCode < 400 && ms < 3000) return;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 && res.statusCode !== 401 && res.statusCode !== 404 ? 'warn' : 'info';
      const user = (res.locals.caller as Identity | undefined)?.name;
      log.log(level, 'http', `${req.method} ${req.path} ${res.statusCode} ${Math.round(ms)} ms`, { id, ip: req.ip, ...(user ? { user } : {}) });
    });
    next();
  };
}

/** Changes must come from this site's own pages, never from another site. */
function sameOrigin(req: Request, _res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  if (req.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed', 'not_granted');
  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      // "null" or garbage: treated as cross-site below.
    }
    if (host !== req.get('host')) throw new HttpError(403, 'Cross-site requests are not allowed', 'not_granted');
  }
  next();
}

function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // data: and blob: for pasted and freshly picked photos, which the page reads back.
      // TCGplayer's and TCGdex's pictures, shown when choosing which product a card is.
      "img-src 'self' data: blob: https://tcgplayer-cdn.tcgplayer.com https://assets.tcgdex.net",
      "font-src 'self'",
      "connect-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=63072000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // The camera is allowed: "Take photo" opens it.
  res.setHeader('Permissions-Policy', 'microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  next();
}
