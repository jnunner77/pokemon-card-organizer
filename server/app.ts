import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { type Accounts, type Caller, type Role, SESSION_COOKIE, atLeast, schemas } from './accounts';
import { Assets, MAX_IMAGE_BYTES } from './assets';
import type { Autofill } from './autofill';
import { RestoreError, makeBackup, restoreBackup } from './backup';
import { Backups } from './backups';
import { dirBytes, freeBytes, runChecks } from './checks';
import { Config, pricingConfigSchema, retentionSchema } from './config';
import type { CardDetails } from './details';
import { GUEST_COOKIE, GUEST_IDLE_MS, GuestFeed, type Guests, guestSchemas, isListed, shownImage } from './guests';
import { CATEGORIES, LEVELS, type Logger, quietLogger } from './log';
import { NoToken, type PriceCharting } from './pricing/pricecharting';
import { Refused, SourceError } from './pricing/sources';
import type { PriceUpdater, RunProblem, RunSummary } from './pricing/updater';
import { problemFeed } from './problems';
import { InvalidDoc, collectionSchema, idSchema } from './schema';
import { HttpError, MUTATING, type Security } from './security';
import type { Secret } from './secrets';
import { cardsNeedingAttention, readOffsite, statusText, writeStatus } from './status';
import { NotFound, SaveFailed, type Store } from './store';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AppOptions {
  store: Store;
  assets: Assets;
  /** The pages, styles and scripts. Defaults to ./public. */
  publicDir?: string;
  trustProxy?: boolean | number | string;
  /** Daily price and image updates; the pricing routes answer 503 without one. */
  updater?: PriceUpdater;
  /** People and sign-in. Without it everything is open (only for running on your own computer). */
  accounts?: Accounts;
  /** Rate limits and blocks; off when not given. */
  security?: Security;
  log?: Logger;
  config?: Config;
  backups?: Backups;
  /** BINDER_PASSWORD, for the check that it no longer opens the admin account. */
  envPassword?: string;
  /** Card details lookups (TCGdex); the lookup routes answer 503 without them. */
  details?: CardDetails;
  /** The clock for the Administration checks and backups (tests set it; defaults to the real time). */
  now?: () => Date;
  /** New cards filling themselves in, and Fill in missing details. */
  autofill?: Autofill;
  /** Guests looking through the cards listed for sale; the guest routes answer 404 without it. */
  guests?: Guests;
  /** PriceCharting's API token (its own secret file, outside the data that's backed up) and its client. */
  pricecharting?: { token: Secret; api: PriceCharting };
}

/** Largest restore upload. The reverse proxy may cap it lower; `npm run import-backup` has no cap. */
const RESTORE_LIMIT = '200mb';
/** Settings documents the page may write; the rest are the server's own. */
const WRITABLE_SETTINGS = new Set(['main']);
/**
 * Anyone may load these: the sign-in page and what it needs, and the guest page (whose API checks
 * for a signed-in guest itself).
 */
const PUBLIC = [/^\/login\.(html|js)$/, /^\/styles\.css$/, /^\/icon\.svg$/, /^\/fonts\//, /^\/api\/(health|auth\/(me|login|logout|password|setup))$/, /^\/guest\.(html|js)$/, /^\/(search|back)\.js$/, /^\/api\/guest\//];
const PAGES = new Set(['/', '/index.html', '/admin.html']);
const LOCAL = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

export function createApp(o: AppOptions) {
  const { store, assets, publicDir = path.join(root, 'public'), trustProxy, updater, accounts, security, guests } = o;
  const log = o.log ?? quietLogger();
  const config = o.config ?? new Config(store.dataDir);
  const now = o.now ?? (() => new Date());
  const backups = o.backups ?? new Backups(store, assets, config, log, now);

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

  // ---- every request ------------------------------------------------------------------
  app.use(requestLog(log));
  app.use(securityHeaders);
  // A guest from the QR code, if any, before the firewall so they get a guest's limits. Their page's
  // twice-a-minute check (GET /api/guest/me) and live updates (GET /api/guest/events) don't count as
  // using it, so idle guests still time out.
  if (guests) {
    const quiet = new Set(['/api/guest/me', '/api/guest/events']);
    app.use((req, res, next) => {
      const token = readCookie(req, GUEST_COOKIE);
      if (token) res.locals.guest = guests.identify(token, !(req.method === 'GET' && quiet.has(req.path))) ?? undefined;
      next();
    });
  }
  if (security) app.use(security.firewall);

  // Who is calling: a session cookie, an API token, or (without accounts) the local owner.
  app.use((req, res, next) => {
    if (!accounts) {
      res.locals.caller = { user: { id: 'local', username: 'local', name: 'Local', role: 'admin' }, role: 'admin', via: 'session' } as unknown as Caller;
    } else {
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
      const caller = accounts.identify(readCookie(req, SESSION_COOKIE), bearer);
      if (bearer && !caller) return void res.status(401).json({ error: 'Invalid or expired API token', code: 'token' });
      res.locals.caller = caller ?? undefined;
    }
    res.locals.user = (res.locals.caller as Caller | undefined)?.user;
    next();
  });

  // Signed-out visitors get the sign-in page; everything with data needs a session or token.
  app.use((req, res, next) => {
    const caller = res.locals.caller as Caller | undefined;
    if (PUBLIC.some((p) => p.test(req.path))) return next();
    if (PAGES.has(req.path) && req.method === 'GET') {
      if (!caller) return void res.redirect(302, 'login.html');
      if (req.path === '/admin.html' && !atLeast(caller.role, 'admin')) return void res.redirect(302, './');
      return next();
    }
    if ((req.path.startsWith('/api/') || req.path.startsWith('/blob/')) && !caller) {
      return void res.status(401).json({ error: 'Please sign in', code: 'signin' });
    }
    next();
  });

  const need = (role: Role) => (_req: Request, res: Response, next: NextFunction) => {
    const caller = res.locals.caller as Caller | undefined;
    if (!caller) throw new HttpError(401, 'Please sign in', 'signin');
    if (!atLeast(caller.role, role)) throw new HttpError(403, role === 'admin' ? 'Only administrators can do this.' : 'You have view-only access.', 'forbidden');
    next();
  };
  const who = (res: Response) => (res.locals.caller as Caller | undefined)?.user.username ?? 'someone';
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

  // ---- signing in ---------------------------------------------------------------------
  const startSession = (req: Request, res: Response, user: Parameters<Accounts['startSession']>[0]) => {
    const token = accounts!.startSession(user, req.ip ?? '', req.get('user-agent') ?? '');
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: accounts!.settings.sessionMaxDays * 86_400_000, path: '/' });
  };
  api.get('/auth/me', (_req, res) => {
    const c = res.locals.caller as Caller | undefined;
    res.json({
      authEnabled: !!accounts,
      setupRequired: !!accounts?.setupCode,
      user: c ? { username: c.user.username, name: c.user.name, role: c.role, via: c.via } : null,
    });
  });
  if (accounts) {
    api.post('/auth/login', json, async (req, res) => {
      const input = schemas.login.parse(req.body);
      const r = await accounts.login(input.username, input.password, req.ip ?? '');
      if (r.status === 'ok') startSession(req, res, r.user);
      res.json({ status: r.status });
    });
    api.post('/auth/password', json, async (req, res) => {
      const input = schemas.change.parse(req.body);
      const user = await accounts.changePassword(input.username, input.currentPassword, input.newPassword, req.ip ?? '');
      startSession(req, res, user);
      res.json({ status: 'ok' });
    });
    api.post('/auth/setup', json, async (req, res) => {
      const user = await accounts.setup(schemas.setup.parse(req.body), req.ip ?? '');
      startSession(req, res, user);
      res.json({ status: 'ok' });
    });
    api.post('/auth/logout', (req, res) => {
      const token = readCookie(req, SESSION_COOKIE);
      if (token) accounts.endSession(token);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(204).end();
    });
  }

  // ---- guests ---------------------------------------------------------------------------
  // The guest page (guest.html, from the QR code): sign in with a name and a phone number or
  // email, then only the cards listed for sale, their details, value and picture.
  if (guests) {
    type SignedInGuest = NonNullable<ReturnType<Guests['identify']>>;
    const guestOf = (res: Response) => res.locals.guest as SignedInGuest | undefined;
    const needGuest = (_req: Request, res: Response, next: NextFunction) => {
      if (!guestOf(res)) throw new HttpError(401, 'Your guest visit ended. Sign in again to keep looking.', 'guest_signin');
      next();
    };
    const usdToCad = () => Number(store.get('settings', 'main')?.usdToCad) || 1;
    const feed = new GuestFeed(store, usdToCad);
    api.get('/guest/me', (req, res) => {
      const g = guestOf(res);
      const k = typeof req.query.k === 'string' ? req.query.k.slice(0, 100) : '';
      res.json({
        open: guests.settings.enabled,
        keyOk: k ? guests.keyMatches(k) : null,
        idleMinutes: GUEST_IDLE_MS / 60_000,
        guest: g ? { name: g.name, contact: g.contact, expiresAt: g.expiresAt } : null,
      });
    });
    api.post('/guest/login', json, (req, res) => {
      const { token, guest } = guests.login(guestSchemas.login.parse(req.body), req.ip ?? '', req.get('user-agent') ?? '');
      res.cookie(GUEST_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
      res.json({ guest: { name: guest.name, contact: guest.contact } });
    });
    api.post('/guest/logout', (req, res) => {
      const token = readCookie(req, GUEST_COOKIE);
      if (token) guests.logout(token);
      res.clearCookie(GUEST_COOKIE, { path: '/' });
      res.status(204).end();
    });
    // The page's "still here": the guest used the page since the last check.
    api.post('/guest/ping', needGuest, (_req, res) => {
      res.json({ expiresAt: guestOf(res)!.expiresAt });
    });
    api.get('/guest/cards', needGuest, (_req, res) => {
      res.json({ cards: feed.cards() });
    });
    // Live updates: the cards guests see, once on connecting and again whenever that changes (a card
    // listed, delisted, sold or repriced), until the visit ends.
    api.get('/guest/events', needGuest, (req, res) => {
      const release = security ? security.openStream(req, res, guestOf(res)!.id) : () => {};
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const token = readCookie(req, GUEST_COOKIE);
      const stillIn = () => !!guests.identify(token, false);
      const send = (json: string) => (stillIn() ? res.write(`event: cards\ndata: ${json}\n\n`) : stop());
      let open = true;
      const stop = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        release();
        res.end();
      };
      const unsubscribe = feed.subscribe(send);
      // A connection that broke is closed (the page reconnects), never left to throw.
      const heartbeat = setInterval(() => {
        try {
          if (stillIn()) res.write(': ping\n\n');
          else stop();
        } catch {
          stop();
        }
      }, 25_000);
      send(feed.current());
      req.on('close', stop);
    });
    api.get('/guest/cards/:id/image', needGuest, (req, res) => {
      const id = idSchema.safeParse(req.params.id);
      const card = id.success ? store.get('cards', id.data) : undefined;
      const img = card && isListed(card) ? shownImage(card) : null;
      if (!img) throw new HttpError(404, 'No such picture', 'not_found');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      // Photos saved before uploads were available are small data: URLs in the card itself.
      const inline = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/s.exec(img);
      if (inline) return void res.type(inline[1]).send(Buffer.from(inline[2], 'base64'));
      const hit = assets.find(img);
      if (!hit) throw new HttpError(404, 'No such picture', 'not_found');
      res.type(hit.type).sendFile(hit.file);
    });
  }

  // ---- errors in the pages themselves --------------------------------------------------
  // A script error or failed promise in a page is reported here and logged, so it shows in the
  // problems banner like any other. At most 30 a minute, so a page stuck in a loop can't flood the log.
  const pageErrorSchema = z.object({
    kind: z.enum(['error', 'rejection']).catch('error'),
    message: z.string().max(500),
    page: z.string().max(200).optional(),
    source: z.string().max(300).optional(),
    line: z.number().int().min(0).max(1e7).optional(),
    col: z.number().int().min(0).max(1e7).optional(),
    stack: z.string().max(2000).optional(),
  });
  const pageErrors = { windowStart: 0, count: 0, warned: false };
  const pageError = (req: Request, res: Response, by: Record<string, unknown>) => {
    const t = now().getTime();
    if (t - pageErrors.windowStart > 60_000) Object.assign(pageErrors, { windowStart: t, count: 0, warned: false });
    if (++pageErrors.count > 30) {
      if (!pageErrors.warned) log.warn('app', 'More than 30 page errors in a minute; not logging more until the minute is up');
      pageErrors.warned = true;
      return void res.status(204).end();
    }
    const e = pageErrorSchema.parse(req.body);
    log.error('app', `Page error${e.page ? ` on ${e.page}` : ''}: ${e.message}`, { kind: e.kind, ...(e.source ? { at: `${e.source}:${e.line ?? '?'}:${e.col ?? '?'}` } : {}), ...(e.stack ? { stack: e.stack } : {}), ...by });
    res.status(204).end();
  };
  api.post('/client-error', need('viewer'), express.json({ limit: '16kb' }), (req, res) => pageError(req, res, { user: who(res) }));
  if (guests) api.post('/guest/client-error', (_req, res, next) => (res.locals.guest ? next() : next(new HttpError(401, 'Please sign in', 'signin'))), express.json({ limit: '16kb' }), (req, res) => pageError(req, res, { guest: true }));

  // ---- binders, cards and settings ----------------------------------------------------
  api.get('/data', need('viewer'), (_req, res) => {
    res.json(store.all());
  });

  const docParams = (req: Request) => {
    const c = collectionSchema.safeParse(req.params.collection);
    const id = idSchema.safeParse(req.params.id);
    if (!c.success) throw new HttpError(404, 'No such collection', 'not_found');
    if (!id.success) throw new HttpError(400, id.error.issues[0].message);
    if (c.data === 'settings' && !WRITABLE_SETTINGS.has(id.data)) throw new HttpError(403, 'That setting belongs to the server.', 'forbidden');
    return { collection: c.data, id: id.data };
  };
  api.put('/docs/:collection/:id', need('editor'), json, (req, res) => {
    const { collection, id } = docParams(req);
    res.json({ id, ...store.set(collection, id, req.body) });
  });
  api.patch('/docs/:collection/:id', need('editor'), json, (req, res) => {
    const { collection, id } = docParams(req);
    res.json({ id, ...store.update(collection, id, req.body) });
  });
  api.delete('/docs/:collection/:id', need('editor'), (req, res) => {
    const { collection, id } = docParams(req);
    store.delete(collection, id);
    res.status(204).end();
  });

  // Sort a binder: the page puts its cards in an order (release date, price) and sends where each
  // one goes. Saved all together, and only if it still covers every card in the binder exactly
  // once, so nothing ends up doubled in a pocket or left behind. Undo sends the old places back.
  // With saveLayout, where the cards are now is kept on the binder too (its own layout), so the
  // page can put them back after sorting by release date or price.
  const arrangeBody = z.object({
    moves: z.array(z.object({ id: idSchema, page: z.number().int().min(1).max(100_000), slot: z.number().int().min(1).max(64) })).max(5000),
    saveLayout: z.boolean().optional(),
  });
  api.post('/binders/:id/arrange', need('editor'), json, (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const binder = id.success ? store.get('binders', id.data) : undefined;
    if (!id.success || !binder) throw new HttpError(404, 'That binder no longer exists.', 'not_found');
    const body = arrangeBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Send each card with its page and pocket.');
    if (binder.kind === 'case') throw new HttpError(400, 'A display case has no pages or pockets to arrange.');
    const pockets = [4, 9, 12, 16].includes(binder.pockets as number) ? (binder.pockets as number) : 9;
    const inBinder = store.all().cards.filter((c) => (c as { binderId?: unknown }).binderId === id.data);
    const ids = new Set(body.data.moves.map((m) => m.id));
    const places = new Set(body.data.moves.map((m) => `${m.page}/${m.slot}`));
    if (ids.size !== body.data.moves.length || ids.size !== inBinder.length || inBinder.some((c) => !ids.has(c.id))) {
      throw new HttpError(409, 'The binder changed meanwhile (a card was added, moved or removed), so nothing moved. Try again.', 'conflict');
    }
    if (places.size !== ids.size) throw new HttpError(400, 'Two cards were given the same pocket.');
    if (body.data.moves.some((m) => m.slot > pockets)) throw new HttpError(400, `This binder's pages have ${pockets} pockets.`);
    const now = new Date().toISOString();
    const patches = body.data.moves
      .filter((m) => { const c = store.get('cards', m.id)!; return c.page !== m.page || c.slot !== m.slot; })
      .map((m) => ({ id: m.id, patch: { page: m.page, slot: m.slot, updatedAt: now } }));
    let layout: { savedAt: string; places: { id: string; page: number; slot: number }[] } | undefined;
    if (body.data.saveLayout) {
      const fits = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
      const kept = inBinder
        .map((c) => ({ id: c.id, page: (c as { page?: unknown }).page, slot: (c as { slot?: unknown }).slot }))
        .filter((c): c is { id: string; page: number; slot: number } => fits(c.page, 100_000) && fits(c.slot, pockets));
      layout = { savedAt: now, places: kept };
    }
    const moved = store.updateMany('cards', patches);
    if (layout) store.update('binders', id.data, { layout });
    log.info('app', `${who(res)} sorted ${String(binder.name ?? 'a binder')}: ${moved} of ${ids.size} cards moved${layout ? ', layout saved' : ''}`);
    res.json({ moved, cards: ids.size, ...(layout ? { layoutSaved: layout.places.length } : {}) });
  });

  // Move cards to another binder (or anywhere): each card goes to the binder, page and pocket
  // given, all together. The pockets they leave stay empty. Refused if a card would land in a
  // pocket another card is in afterwards (one added or moved meanwhile). Undo sends the old places.
  // A display case has no pockets: cards go in it with a blank page and pocket.
  const placeBody = z.object({
    moves: z
      .array(
        z.union([
          z.object({ id: idSchema, binderId: idSchema, page: z.number().int().min(1).max(100_000), slot: z.number().int().min(1).max(64) }),
          z.object({ id: idSchema, binderId: idSchema.nullable(), page: z.null(), slot: z.null() }),
        ]),
      )
      .min(1)
      .max(5000),
  });
  api.post('/cards/place', need('editor'), json, (req, res) => {
    const body = placeBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Send each card with its binder, page and pocket.');
    const moves = body.data.moves;
    if (new Set(moves.map((m) => m.id)).size !== moves.length) throw new HttpError(400, 'A card was given twice.');
    const missing = moves.find((m) => !store.get('cards', m.id));
    if (missing) throw new HttpError(409, 'A card was deleted meanwhile, so nothing moved. Try again.', 'conflict');
    const binderOf = (bid: string) => {
      const b = store.get('binders', bid);
      if (!b) throw new HttpError(409, 'That binder no longer exists, so nothing moved.', 'conflict');
      return b;
    };
    for (const m of moves) {
      if (!m.binderId) continue;
      const b = binderOf(m.binderId);
      if (b.kind === 'case') {
        if (m.page !== null) throw new HttpError(400, `${String(b.name ?? 'That display case')} is a display case: it has no pages or pockets.`);
        continue;
      }
      if (m.page === null) throw new HttpError(400, 'Choose a page and pocket in that binder.');
      const pockets = [4, 9, 12, 16].includes(b.pockets as number) ? (b.pockets as number) : 9;
      if (m.slot! > pockets) throw new HttpError(400, 'That pocket is past the end of the page.');
    }
    // Each card lands in a pocket no other card is in once this is done (the ones moving away free theirs).
    const ids = new Set(moves.map((m) => m.id));
    const key = (at: Record<string, unknown>) => `${String(at.binderId)}/${String(at.page)}/${String(at.slot)}`;
    const taken = new Set(store.all().cards.filter((c) => !ids.has(c.id)).map(key));
    for (const m of moves) {
      if (!m.binderId || m.page === null) continue;
      if (taken.has(key(m))) throw new HttpError(409, 'A pocket was filled meanwhile, so nothing moved. Try again.', 'conflict');
      taken.add(key(m));
    }
    const now = new Date().toISOString();
    const patches = moves
      .filter((m) => { const c = store.get('cards', m.id)!; return (c.binderId ?? null) !== m.binderId || (c.page ?? null) !== m.page || (c.slot ?? null) !== m.slot; })
      .map(({ id, ...at }) => ({ id, patch: { ...at, updatedAt: now } }));
    const moved = store.updateMany('cards', patches);
    log.info('app', `${who(res)} moved ${moved} card${moved === 1 ? '' : 's'}`);
    res.json({ moved });
  });

  // Live updates: every change is pushed to every open page, until the session ends.
  api.get('/events', need('viewer'), (req, res) => {
    const release = security ? security.openStream(req, res) : () => {};
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('event: hello\ndata: {}\n\n');
    const token = readCookie(req, SESSION_COOKIE);
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const stillAllowed = () => !accounts || !!accounts.identify(token, bearer);
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe();
      release();
      res.end();
    };
    const unsubscribe = store.subscribe((e) => (stillAllowed() ? res.write(`data: ${JSON.stringify(e)}\n\n`) : stop()));
    // A connection that broke is closed (the page reconnects), never left to throw.
    const heartbeat = setInterval(() => {
      try {
        if (stillAllowed()) res.write(': ping\n\n');
        else stop();
      } catch {
        stop();
      }
    }, 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      release();
    });
  });

  // ---- photos ---------------------------------------------------------------------------
  api.post('/assets', need('editor'), express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) throw new HttpError(400, 'No photo was sent');
    const saved = assets.put(buf);
    if (!saved) throw new HttpError(415, "That file isn't a JPG, PNG, WebP or GIF picture", 'unsupported_type');
    res.status(201).json(saved);
  });
  api.delete('/assets/:id', need('editor'), (req, res) => {
    // A photo another card still shows is kept, whatever the page thought.
    if (!store.referencedImages().has(String(req.params.id))) assets.remove(String(req.params.id));
    res.status(204).end();
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
  api.post('/pricing/run', need('editor'), heavy, (_req, res) => {
    const u = needUpdater();
    const already = u.running;
    u.runAll('manual').catch((err) => log.error('pricing', `Price update failed: ${err instanceof Error ? err.message : err}`));
    if (!already) log.info('pricing', `${who(res)} started a price update`);
    res.status(202).json({ started: !already });
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
    res.json({ outcome, card: { id, ...store.get('cards', id) } });
  });

  // ---- card details (TCGdex) ---------------------------------------------------------
  const lookupQuery = z.object({
    name: z.string().trim().min(1).max(200),
    number: z.string().trim().min(1).max(40),
    set: z.string().trim().max(200).optional(),
    setCode: z.string().trim().max(40).optional(),
  });
  api.get('/cards/lookup', need('editor'), async (req, res) => {
    if (!o.details) throw new HttpError(503, 'Card lookups are turned off on this server.');
    const q = lookupQuery.safeParse(req.query);
    if (!q.success) throw new HttpError(400, 'Give the card name and number.');
    res.json({ matches: await o.details.lookup(q.data.name, q.data.number, q.data) });
  });
  // "This is my card": one of several matches, or a name suggested for a card not found.
  const chooseBody = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/) });
  api.post('/cards/:id/details', need('editor'), json, async (req, res) => {
    if (!o.details) throw new HttpError(503, 'Card lookups are turned off on this server.');
    const id = idSchema.safeParse(req.params.id);
    if (!id.success || !store.get('cards', id.data)) throw new HttpError(404, 'That card no longer exists.', 'not_found');
    const body = chooseBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Give the TCGdex card id.');
    const result = await o.details.fill(store, id.data, true, body.data.id);
    const card = store.get('cards', id.data);
    if (result === 'error') throw new HttpError(502, "The card database didn't answer. Try again.", 'upstream_error');
    // Its set is known now, which helps find its price.
    if (updater?.schedule().enabled && !updater.running) void updater.updateCard(id.data).catch(() => {});
    res.json({ result, card });
  });
  api.post('/cards/fill-details', need('editor'), heavy, (req, res) => {
    if (!o.autofill) throw new HttpError(503, 'Card lookups are turned off on this server.');
    const already = o.autofill.fillingAll;
    const cards = o.autofill.fillAll(req.query.force === '1');
    if (!already) log.info('pricing', `${who(res)} started Fill in missing details (${cards} cards)`);
    res.status(202).json({ started: !already, cards });
  });

  // ---- full backups (with photos) -----------------------------------------------------
  api.get('/backup', need('editor'), heavy, (_req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="binder-ledger-backup-${stamp}.json"`);
    config.set({ lastFullBackupAt: now().toISOString() });
    log.info('backup', `${who(res)} downloaded a full backup`);
    res.json(makeBackup(store, assets));
  });
  api.post('/restore', need('admin'), heavy, express.json({ limit: RESTORE_LIMIT }), (req, res) => {
    const summary = restoreBackup(store, assets, req.body);
    log.warn('backup', `${who(res)} restored a full backup`, { ...summary });
    res.json(summary);
  });

  // ---- administration ------------------------------------------------------------------
  const admin = express.Router();
  admin.use(need('admin'));
  const needAccounts = () => {
    if (!accounts) throw new HttpError(400, 'Sign-in is turned off on this server (AUTH=off).');
    return accounts;
  };

  /** The Overview's checks. Without a request (the status file) HTTPS and proxy checks are left out by statusText. */
  const overviewChecks = async (request: { secure: boolean; untrustedProxy: boolean; localRequest: boolean }) => {
    const pricingStatus = (store.get('settings', 'pricing') ?? {}) as { running?: boolean; lastRun?: { date: string; finishedAt: string; counts: Record<string, number> }; problem?: RunProblem | null };
    const sch = updater?.schedule();
    const counts = log.counts(86_400_000);
    const failed = log.query({ cat: 'auth', text: 'failed sign-in', limit: 5000 }).filter((e) => now().getTime() - Date.parse(e.at) < 86_400_000).length;
    const sec = security?.summary();
    return runChecks({
      now: now(),
      ...request,
      authEnabled: !!accounts,
      accounts: accounts ? accounts.health() : null,
      envPasswordStillWorks: accounts ? await accounts.envPasswordStillWorks(o.envPassword) : false,
      security: { enabled: !!security, bans: sec?.bans.length ?? 0, limited: sec?.stats.limited ?? 0, blocked: sec?.stats.blocked ?? 0, allowlist: sec?.allowlist.length ?? 0 },
      failedSignIns24h: failed,
      backups: backups.health(),
      lastFullBackupAt: config.get().lastFullBackupAt,
      offsite: readOffsite(store.dataDir),
      logs: { fileOk: log.fileOk, dir: log.dir, errors24h: counts.error, warnings24h: counts.warn },
      pricing: { enabled: !!updater && (sch?.enabled ?? false), hour: sch?.hour ?? 5, timeZone: sch?.timeZone ?? '', lastRun: pricingStatus.lastRun ?? null, running: !!pricingStatus.running, problem: pricingStatus.problem ?? null, rateDate: (store.get('settings', 'main')?.usdToCadDate as string) ?? null },
      disk: { freeBytes: freeBytes(store.dataDir), dataBytes: dirBytes(store.dataDir) },
    });
  };
  /** Write status.txt for the server's nightly job (see status.ts). */
  const writeStatusFile = async () => {
    const checks = await overviewChecks({ secure: true, untrustedProxy: false, localRequest: false });
    writeStatus(store.dataDir, statusText(now(), checks, cardsNeedingAttention(store.all().cards as Parameters<typeof cardsNeedingAttention>[0])));
  };

  admin.get('/overview', async (req, res) => {
    const caller = res.locals.caller as Caller;
    const checks = await overviewChecks({ secure: req.secure, untrustedProxy: !!req.get('x-forwarded-for') && !app.get('trust proxy'), localRequest: LOCAL.test(req.ip ?? '') });
    const all = store.all();
    res.json({
      checks,
      you: { username: caller.user.username, name: caller.user.name },
      ledger: { binders: all.binders.length, cards: all.cards.length, ...assets.usage() },
      server: { node: process.version, uptimeHours: Math.round(process.uptime() / 360) / 10, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() },
    });
  });

  // People
  admin.get('/users', (_req, res) => {
    res.json({ users: needAccounts().users(), settings: needAccounts().settings });
  });
  admin.post('/users', json, async (req, res) => {
    res.status(201).json(await needAccounts().createUser(schemas.createUser.parse(req.body), who(res)));
  });
  admin.patch('/users/:id', json, (req, res) => {
    res.json(needAccounts().updateUser(String(req.params.id), schemas.updateUser.parse(req.body), who(res)));
  });
  admin.post('/users/:id/password', json, async (req, res) => {
    const input = schemas.setPassword.parse(req.body);
    res.json(await needAccounts().setPassword(String(req.params.id), input.password, input.mustChange, who(res)));
  });
  admin.post('/users/:id/signout', (req, res) => {
    const n = needAccounts().revokeSessions(String(req.params.id));
    log.info('admin', `${who(res)} signed a person out of ${n} session${n === 1 ? '' : 's'}`);
    res.json({ signedOut: n });
  });
  admin.delete('/users/:id', (req, res) => {
    needAccounts().deleteUser(String(req.params.id), who(res));
    res.status(204).end();
  });
  admin.put('/settings', json, (req, res) => {
    res.json(needAccounts().updateSettings(schemas.settings.parse(req.body), who(res)));
  });

  // Sessions and API tokens
  admin.get('/sessions', (_req, res) => {
    res.json({ sessions: needAccounts().listSessions() });
  });
  admin.delete('/sessions/:id', (req, res) => {
    needAccounts().revokeSession(String(req.params.id));
    log.info('admin', `${who(res)} ended a session`);
    res.status(204).end();
  });
  admin.get('/tokens', (_req, res) => {
    res.json({ tokens: needAccounts().tokens() });
  });
  admin.post('/tokens', json, (req, res) => {
    res.status(201).json(needAccounts().createToken(schemas.createToken.parse(req.body), who(res)));
  });
  admin.delete('/tokens/:id', (req, res) => {
    needAccounts().revokeToken(String(req.params.id), who(res));
    res.status(204).end();
  });

  // Backups
  admin.get('/backups', (_req, res) => {
    res.json({ backups: backups.list(), retention: config.get().backups, lastFullBackupAt: config.get().lastFullBackupAt, photos: assets.usage() });
  });
  admin.put('/backups/retention', json, (req, res) => {
    const retention = retentionSchema.parse(req.body);
    config.set({ backups: retention });
    const removed = backups.prune();
    log.info('admin', `${who(res)} changed backup retention`, { ...retention, removed });
    res.json({ retention, removed });
  });
  admin.post('/backups/snapshot', heavy, json, (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 40) : undefined;
    res.status(201).json(backups.snapshot(label, who(res)));
  });
  admin.get('/backups/:name', heavy, (req, res) => {
    const file = backups.file(String(req.params.name));
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
    res.type('application/json').sendFile(file);
  });
  admin.post('/backups/:name/restore', heavy, (req, res) => {
    res.json(backups.restore(String(req.params.name), who(res)));
  });
  admin.delete('/backups/:name', (req, res) => {
    backups.remove(String(req.params.name), who(res));
    res.status(204).end();
  });

  // Price updates
  admin.get('/pricing', (_req, res) => {
    const st = (store.get('settings', 'pricing') ?? {}) as Record<string, unknown>;
    // Whether PriceCharting's token is saved, and when: never the token itself.
    // The token's state (never the token), and how PriceCharting is being used today.
    const pricecharting = o.pricecharting ? { ...o.pricecharting.token.info(), usage: o.pricecharting.api.usageNow() } : null;
    res.json({ available: !!updater, schedule: updater?.schedule() ?? null, pricecharting, running: !!st.running, done: st.done ?? 0, total: st.total ?? 0, current: st.current ?? null, problem: st.problem ?? null, history: st.history ?? (st.lastRun ? [st.lastRun] : []) });
  });
  admin.put('/pricing', json, (req, res) => {
    const pricing = { ...config.get().pricing, ...pricingConfigSchema.parse(req.body) };
    config.set({ pricing });
    log.info('admin', `${who(res)} changed the price update schedule`, { ...pricing });
    res.json({ schedule: updater?.schedule() ?? { ...pricing } });
  });
  const needPc = () => {
    if (!o.pricecharting || !updater) throw new HttpError(400, 'PriceCharting prices are not available on this server.');
    return o.pricecharting;
  };
  // PriceCharting's API token: 40 letters and digits, from PriceCharting's Subscription page → API/Download.
  const tokenBody = z.object({ token: z.string().trim().regex(/^[A-Za-z0-9]{20,100}$/, "That isn't a PriceCharting API token: copy the 40-character token from PriceCharting's Subscription page (API/Download).") });
  admin.put('/pricing/pricecharting-token', heavy, json, async (req, res) => {
    const pc = needPc();
    const body = tokenBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, body.error.issues[0].message);
    // One call to PriceCharting with it first: a token it doesn't know isn't saved.
    try {
      await pc.api.check(body.data.token);
    } catch (err) {
      if (err instanceof Refused || err instanceof NoToken) throw new HttpError(400, "PriceCharting didn't accept that token. Check you copied all of it from its Subscription page (API/Download).");
      throw new HttpError(502, `Couldn't check the token with PriceCharting: ${err instanceof Error ? err.message : err}. Try again.`, 'upstream_error');
    }
    pc.token.write(body.data.token);
    updater!.noteToken();
    log.info('admin', `${who(res)} saved the PriceCharting API token`);
    res.json({ pricecharting: pc.token.info() });
  });
  admin.delete('/pricing/pricecharting-token', (_req, res) => {
    const pc = needPc();
    pc.token.clear();
    pc.api.forget();
    updater!.noteToken();
    log.info('admin', `${who(res)} removed the PriceCharting API token`);
    res.json({ pricecharting: pc.token.info() });
  });
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

  // Guests
  const needGuests = () => {
    if (!guests) throw new HttpError(400, 'Guest viewing is not available on this server.');
    return guests;
  };
  /** The QR code's link: next to the Administration page the person has open (base), or this host. */
  const guestLink = (req: Request, key: string) => {
    let base = `${req.protocol}://${req.get('host')}/`;
    const asked = typeof req.query.base === 'string' ? req.query.base : '';
    try {
      const u = new URL(asked);
      if (/^https?:$/.test(u.protocol) && u.host === req.get('host')) base = u.href;
    } catch {
      // No base, or not a link: this host.
    }
    const u = new URL('guest.html', base);
    u.searchParams.set('k', key);
    return u.href;
  };
  admin.get('/guests', async (req, res) => {
    const g = needGuests();
    const st = g.settings;
    const url = guestLink(req, st.key);
    res.json({
      enabled: st.enabled,
      keyCreatedAt: st.keyCreatedAt,
      idleMinutes: GUEST_IDLE_MS / 60_000,
      url,
      qr: await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }),
      listed: store.all().cards.filter(isListed).length,
      active: g.active(),
      log: g.visits(),
    });
  });
  admin.put('/guests', json, (req, res) => {
    const { enabled } = guestSchemas.settings.parse(req.body);
    res.json({ enabled: needGuests().setEnabled(enabled, who(res)).enabled });
  });
  admin.post('/guests/key', (_req, res) => {
    needGuests().newKey(who(res));
    res.status(204).end();
  });
  admin.delete('/guests/sessions/:id', (req, res) => {
    needGuests().endSession(String(req.params.id), who(res));
    res.status(204).end();
  });
  admin.delete('/guests/log', (_req, res) => {
    res.json({ removed: needGuests().clearLog(who(res)) });
  });

  // Problems: every warning and error since an administrator last marked them as seen, grouped.
  admin.get('/problems', (req, res) => {
    res.json(problemFeed(log, config.get().problemsSeenAt ?? null, { all: req.query.all === '1' }));
  });
  admin.post('/problems/seen', json, (req, res) => {
    const { upTo } = z.object({ upTo: z.iso.datetime().optional() }).parse(req.body ?? {});
    // Up to the newest one the page showed, so one logged meanwhile still counts as new.
    const at = upTo && upTo < now().toISOString() ? upTo : now().toISOString();
    config.set({ problemsSeenAt: at });
    res.json(problemFeed(log, at));
  });

  // Logs
  const logQuery = z.object({ level: z.enum(LEVELS as [string, ...string[]]).optional(), cat: z.enum(CATEGORIES as [string, ...string[]]).optional(), q: z.string().max(200).optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });
  admin.get('/logs', (req, res) => {
    const q = logQuery.parse(req.query);
    res.json({ entries: log.query({ level: q.level as never, cat: q.cat as never, text: q.q, before: q.before, limit: q.limit ?? 200 }), files: log.files() });
  });
  admin.get('/logs/files/:name', (req, res) => {
    const name = String(req.params.name);
    if (!log.dir || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || !fs.existsSync(path.join(log.dir, name))) throw new HttpError(404, 'No such log file', 'not_found');
    res.setHeader('Content-Disposition', `attachment; filename="binder-log-${name}"`);
    res.type('text/plain').sendFile(path.join(log.dir, name));
  });
  api.use('/admin', admin);

  api.use((_req, _res) => {
    throw new HttpError(404, 'Not found', 'not_found');
  });
  app.use('/api', api);

  app.get('/blob/:id', (req, res) => {
    const hit = assets.find(String(req.params.id));
    if (!hit) return void res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type(hit.type).sendFile(hit.file);
  });

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
    else if (err instanceof InvalidDoc || err instanceof RestoreError) [status, message] = [400, err.message];
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
  return Object.assign(app, { writeStatusFile });
}

/** Log API requests, failures and slow requests (pictures and page files only when they fail). */
function requestLog(log: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const id = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', id);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const isApi = req.path.startsWith('/api/') && req.path !== '/api/health' && req.path !== '/api/events';
      if (!isApi && res.statusCode < 400 && ms < 3000) return;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 && res.statusCode !== 401 && res.statusCode !== 404 ? 'warn' : 'info';
      const user = (res.locals.caller as Caller | undefined)?.user.username;
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

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
