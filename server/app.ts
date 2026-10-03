import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Assets, MAX_IMAGE_BYTES } from './assets';
import type { Auth } from './auth';
import { RestoreError, makeBackup, restoreBackup } from './backup';
import { SourceError } from './pricing/sources';
import type { PriceUpdater } from './pricing/updater';
import { InvalidDoc, collectionSchema, idSchema } from './schema';
import { NotFound, type Store } from './store';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AppOptions {
  store: Store;
  assets: Assets;
  /** The page, styles and script. Defaults to ./public. */
  publicDir?: string;
  trustProxy?: boolean | number | string;
  /** Daily price and image updates; the pricing routes answer 503 without one. */
  updater?: PriceUpdater;
  /** Password sign-in; without it everything is open. */
  auth?: Auth;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'invalid_argument',
  ) {
    super(message);
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Largest restore upload. The reverse proxy may cap it lower; `npm run import-backup` has no cap. */
const RESTORE_LIMIT = '200mb';

export function createApp({ store, assets, publicDir = path.join(root, 'public'), trustProxy, updater, auth }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(securityHeaders);
  if (auth) app.use(auth.guard);

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  api.use(sameOrigin);
  if (auth) api.use(auth.routes());

  // ---- Binders, cards and settings ------------------------------------------------
  api.get('/data', (_req, res) => {
    res.json(store.all());
  });

  const docParams = (req: Request) => {
    const c = collectionSchema.safeParse(req.params.collection);
    const id = idSchema.safeParse(req.params.id);
    if (!c.success) throw new HttpError(404, 'No such collection', 'not_found');
    if (!id.success) throw new HttpError(400, id.error.issues[0].message);
    return { collection: c.data, id: id.data };
  };
  const json = express.json({ limit: '1mb' });

  api.put('/docs/:collection/:id', json, (req, res) => {
    const { collection, id } = docParams(req);
    res.json({ id, ...store.set(collection, id, req.body) });
  });
  api.patch('/docs/:collection/:id', json, (req, res) => {
    const { collection, id } = docParams(req);
    res.json({ id, ...store.update(collection, id, req.body) });
  });
  api.delete('/docs/:collection/:id', (req, res) => {
    const { collection, id } = docParams(req);
    store.delete(collection, id);
    res.status(204).end();
  });

  // Live updates: every change is pushed to every open page.
  api.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: hello\ndata: {}\n\n');
    const unsubscribe = store.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---- Photos -----------------------------------------------------------------------
  api.post('/assets', express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) throw new HttpError(400, 'No photo was sent');
    const saved = assets.put(buf);
    if (!saved) throw new HttpError(415, "That file isn't a JPG, PNG, WebP or GIF picture", 'unsupported_type');
    res.status(201).json(saved);
  });
  api.delete('/assets/:id', (req, res) => {
    // A photo another card still shows is kept, whatever the page thought.
    if (!store.referencedImages().has(String(req.params.id))) assets.remove(String(req.params.id));
    res.status(204).end();
  });

  // ---- Automatic prices and images --------------------------------------------------
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
  // Update every card now (the same as the daily run). Answers at once; progress shows in settings/pricing.
  api.post('/pricing/run', (_req, res) => {
    const u = needUpdater();
    const already = u.running;
    u.runAll('manual').catch((err) => console.error('Price update failed:', err));
    res.status(202).json({ started: !already });
  });
  // Products on PriceCharting and TCGplayer that could be this card.
  api.get('/pricing/search', async (req, res) => {
    const { card } = cardFor(req.query.card);
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : undefined;
    res.json({ candidates: await needUpdater().search(card, q) });
  });
  const linkSchema = z.union([
    z.object({ source: z.enum(['off', 'auto']) }),
    z.object({
      source: z.enum(['pricecharting', 'tcgplayer']),
      id: z.string().min(1).max(300),
      url: z.string().max(500).optional(),
      title: z.string().max(300).optional(),
      set: z.string().max(200).optional(),
    }),
  ]);
  // Link the card to a product (or turn automatic pricing off or back on), then update it.
  api.post('/pricing/link/:id', json, async (req, res) => {
    const { id } = cardFor(req.params.id);
    const choice = linkSchema.safeParse(req.body);
    if (!choice.success) throw new HttpError(400, choice.error.issues[0].message);
    const c = choice.data;
    const outcome = await needUpdater().link(id, 'id' in c ? { source: c.source, id: c.id, url: c.url ?? '', title: c.title ?? '', set: c.set ?? '' } : c);
    res.json({ outcome, card: { id, ...store.get('cards', id) } });
  });
  // Update one card's price and image now.
  api.post('/pricing/refresh/:id', async (req, res) => {
    const { id } = cardFor(req.params.id);
    const outcome = await needUpdater().updateCard(id);
    res.json({ outcome, card: { id, ...store.get('cards', id) } });
  });

  // ---- Backups ------------------------------------------------------------------------
  api.get('/backup', (_req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="binder-ledger-backup-${stamp}.json"`);
    res.json(makeBackup(store, assets));
  });
  api.post('/restore', express.json({ limit: RESTORE_LIMIT }), (req, res) => {
    res.json(restoreBackup(store, assets, req.body));
  });

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

  // Fonts are served from their npm packages so the page needs nothing from other sites.
  const fontOpts = { immutable: true, maxAge: '365d', index: false } as const;
  app.use('/fonts/archivo', express.static(path.join(root, 'node_modules/@fontsource-variable/archivo'), fontOpts));
  app.use('/fonts/jetbrains-mono', express.static(path.join(root, 'node_modules/@fontsource/jetbrains-mono'), fontOpts));
  // The page and its script change with each release, so browsers check for a newer copy every time.
  app.use(express.static(publicDir, { index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; type?: string; message?: string };
    let status = 500;
    let code = 'internal';
    let message = 'Something went wrong on the server';
    if (err instanceof HttpError) ({ status, code, message } = err);
    else if (err instanceof InvalidDoc || err instanceof RestoreError) [status, message] = [400, err.message];
    else if (err instanceof SourceError) [status, code, message] = [502, 'upstream_error', err.message];
    else if (err instanceof NotFound) [status, code, message] = [404, 'not_found', err.message];
    else if (e?.type === 'entity.too.large') [status, code, message] = [413, 'too_large', 'That upload is too large'];
    else if (e?.type === 'entity.parse.failed') [status, message] = [400, "The request body isn't valid JSON"];
    else console.error(err);
    if (status === 400 && code === 'internal') code = 'invalid_argument';
    res.status(status).json({ error: message, code });
  });
  return app;
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

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // data: and blob: for pasted and freshly picked photos, which the page reads back.
      // Price sites' thumbnails, shown when choosing which product a card is.
      "img-src 'self' data: blob: https://storage.googleapis.com https://tcgplayer-cdn.tcgplayer.com",
      "font-src 'self'",
      "connect-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // The camera is allowed: "Take photo" opens it.
  res.setHeader('Permissions-Policy', 'microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  next();
}
