import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireRole } from '#application/access.ts';
import type { ClearGuestLog } from '#application/guests/clear-guest-log.ts';
import type { EndGuestVisit } from '#application/guests/end-guest-visit.ts';
import type { GuestOverview } from '#application/guests/guest-overview.ts';
import type { GuestStatus } from '#application/guests/guest-status.ts';
import type { IdentifyGuest } from '#application/guests/identify-guest.ts';
import type { ListGuestCards } from '#application/guests/list-guest-cards.ts';
import type { NewGuestKey } from '#application/guests/new-guest-key.ts';
import type { OpenGuestPicture } from '#application/guests/open-guest-picture.ts';
import type { SetGuestViewing } from '#application/guests/set-guest-viewing.ts';
import type { SignInGuest } from '#application/guests/sign-in-guest.ts';
import type { SignOutGuest } from '#application/guests/sign-out-guest.ts';
import type { SignedInGuest } from '#application/guests/state.ts';
import { GUEST_IDLE_MS } from '#domain/guests/visits.ts';
import { readJsonBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import type { ClientResolver } from '../http/client.ts';
import { clearedCookie, readCookie, signInCookie } from '../http/cookies.ts';
import { accessFailure, badRequest, bodyFailure } from '../http/errors.ts';
import { boolField, fieldsOf, textField } from '../http/fields.ts';
import { sendFailure, sendJson, sendNoContent } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import type { StreamGate } from '../http/streams.ts';
import { sendPhoto } from '../photos/send-photo.ts';
import { GUEST_SIGN_IN, GUESTS_UNAVAILABLE, guestFailure, NO_PICTURE } from './errors.ts';
import type { GuestCardFeed } from './feed.ts';

export const GUEST_COOKIE = 'binder_guest';
const MAX_KEY = 100;
const HEARTBEAT_MS = 25_000;

/** Who the guest behind a request is, as the request pipeline identified them (before its rate limits). */
export type GuestResolver = (req: IncomingMessage) => SignedInGuest | null;

export interface GuestUseCases {
  readonly status: Pick<GuestStatus, 'execute'>;
  readonly signIn: Pick<SignInGuest, 'execute'>;
  readonly identify: Pick<IdentifyGuest, 'execute'>;
  readonly signOut: Pick<SignOutGuest, 'execute'>;
  readonly listCards: Pick<ListGuestCards, 'execute'>;
  readonly openPicture: Pick<OpenGuestPicture, 'execute'>;
  readonly overview: Pick<GuestOverview, 'execute'>;
  readonly setViewing: Pick<SetGuestViewing, 'execute'>;
  readonly newKey: Pick<NewGuestKey, 'execute'>;
  readonly endVisit: Pick<EndGuestVisit, 'execute'>;
  readonly clearLog: Pick<ClearGuestLog, 'execute'>;
  readonly feed: GuestCardFeed;
}

export interface GuestRouteDeps {
  readonly identify: CallerResolver;
  readonly guest: GuestResolver;
  readonly client: ClientResolver;
  readonly streams: StreamGate;
  /** Null when this server has no guest viewing: the guest page's routes are absent, Administration says so. */
  readonly guests: GuestUseCases | null;
}

/** The guest page from the QR code (/guest/…) and Administration → Guests, relative to /api. */
export function guestRoutes(deps: GuestRouteDeps): Router {
  const { guests } = deps;

  const admin = (req: IncomingMessage, res: ServerResponse): { readonly actor: string; readonly guests: GuestUseCases } | null => {
    const allowed = requireRole(deps.identify(req), 'admin');
    if (!allowed.ok) {
      req.resume();
      sendFailure(res, accessFailure(allowed.error));
      return null;
    }
    if (!guests) {
      req.resume();
      sendFailure(res, GUESTS_UNAVAILABLE);
      return null;
    }
    return { actor: allowed.value.name, guests };
  };
  const signedIn = (req: IncomingMessage, res: ServerResponse): SignedInGuest | null => {
    const g = deps.guest(req);
    if (g) return g;
    req.resume();
    sendFailure(res, GUEST_SIGN_IN);
    return null;
  };

  const router = new Router();
  if (guests) {
    router
      .add('GET', '/guest/me', async (req, res) => {
        const g = deps.guest(req);
        const key = new URL(req.url ?? '/', 'http://x').searchParams.get('k')?.slice(0, MAX_KEY) ?? '';
        const status = await guests.status.execute({ key });
        sendJson(res, 200, { ...status, idleMinutes: GUEST_IDLE_MS / 60_000, guest: g ? { name: g.name, contact: g.contact, expiresAt: g.expiresAt } : null });
      })
      .add('POST', '/guest/login', async (req, res) => {
        const read = await readJsonBody(req);
        if (!read.ok) return sendFailure(res, bodyFailure(read.error));
        const fields = fieldsOf(read.value, ['key', 'name', 'contact']);
        if (!fields.ok) return sendFailure(res, badRequest(fields.error));
        const key = textField(fields.value, 'key', { max: MAX_KEY });
        const name = textField(fields.value, 'name');
        const contact = textField(fields.value, 'contact');
        for (const r of [key, name, contact]) if (!r.ok) return sendFailure(res, badRequest(r.error));
        if (!key.ok || !name.ok || !contact.ok) return;
        const client = deps.client(req);
        const r = await guests.signIn.execute({ key: key.value, name: name.value, contact: contact.value, ip: client.ip, agent: req.headers['user-agent'] ?? '' });
        if (!r.ok) return sendFailure(res, guestFailure(r.error));
        res.setHeader('Set-Cookie', signInCookie(GUEST_COOKIE, r.value.token, { secure: client.secure }));
        sendJson(res, 200, { guest: { name: r.value.guest.name, contact: r.value.guest.contact } });
      })
      .add('POST', '/guest/logout', async (req, res) => {
        req.resume();
        const token = readCookie(req, GUEST_COOKIE);
        if (token) await guests.signOut.execute({ token });
        res.setHeader('Set-Cookie', clearedCookie(GUEST_COOKIE));
        sendNoContent(res);
      })
      // The page's "still here": the guest used the page since the last check.
      .add('POST', '/guest/ping', async (req, res) => {
        const g = signedIn(req, res);
        if (!g) return;
        req.resume();
        sendJson(res, 200, { expiresAt: g.expiresAt });
      })
      .add('GET', '/guest/cards', async (req, res) => {
        if (!signedIn(req, res)) return;
        sendJson(res, 200, { cards: await guests.listCards.execute() });
      })
      // Live updates: the cards guests see, once on connecting and again whenever that changes (a card
      // listed, delisted, sold or repriced), until the visit ends.
      .add('GET', '/guest/events', async (req, res) => {
        const g = signedIn(req, res);
        if (!g) return;
        const gate = deps.streams(req, res, g.id);
        if ('refused' in gate) return sendFailure(res, gate.refused);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const token = readCookie(req, GUEST_COOKIE);
        let open = true;
        // Writes go out one at a time, each after checking the visit hasn't ended.
        let queue = Promise.resolve();
        const whileIn = (write: () => void) => {
          queue = queue.then(async () => {
            if (!open) return;
            try {
              if (await guests.identify.execute({ token, touch: false })) write();
              else stop();
            } catch {
              stop();
            }
          });
        };
        const stop = () => {
          if (!open) return;
          open = false;
          clearInterval(heartbeat);
          unsubscribe();
          gate.release();
          res.end();
        };
        const send = (json: string) => whileIn(() => res.write(`event: cards\ndata: ${json}\n\n`));
        const unsubscribe = guests.feed.subscribe(send);
        // A connection that broke is closed (the page reconnects), never left to throw.
        const heartbeat = setInterval(() => whileIn(() => res.write(': ping\n\n')), HEARTBEAT_MS);
        req.on('close', stop);
        send(await guests.feed.current());
      })
      .add('GET', '/guest/cards/:id/image', async (req, res, p) => {
        if (!signedIn(req, res)) return;
        const picture = await guests.openPicture.execute({ cardId: p['id'] ?? '' });
        if (!picture) return sendFailure(res, NO_PICTURE);
        if (picture.kind === 'photo') return sendPhoto(req, res, picture.photo, 'private, max-age=3600');
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('Content-Type', picture.type);
        res.setHeader('Content-Length', picture.bytes.length);
        res.end(req.method === 'HEAD' ? undefined : picture.bytes);
      });
  }

  return (
    router
      .add('GET', '/admin/guests', async (req, res) => {
        const a = admin(req, res);
        if (!a) return;
        sendJson(res, 200, await a.guests.overview.execute({ linkFor: (key) => guestLink(req, deps.client(req).secure, key) }));
      })
      .add('PUT', '/admin/guests', async (req, res) => {
        const a = admin(req, res);
        if (!a) return;
        const read = await readJsonBody(req);
        if (!read.ok) return sendFailure(res, bodyFailure(read.error));
        const fields = fieldsOf(read.value, ['enabled']);
        const enabled = fields.ok ? boolField(fields.value, 'enabled') : fields;
        if (!enabled.ok) return sendFailure(res, badRequest(enabled.error));
        sendJson(res, 200, await a.guests.setViewing.execute({ actor: a.actor, enabled: enabled.value }));
      })
      .add('POST', '/admin/guests/key', async (req, res) => {
        const a = admin(req, res);
        if (!a) return;
        req.resume();
        await a.guests.newKey.execute({ actor: a.actor });
        sendNoContent(res);
      })
      .add('DELETE', '/admin/guests/sessions/:id', async (req, res, p) => {
        const a = admin(req, res);
        if (!a) return;
        req.resume();
        const r = await a.guests.endVisit.execute({ actor: a.actor, id: p['id'] ?? '' });
        if (r.ok) sendNoContent(res);
        else sendFailure(res, guestFailure(r.error));
      })
      .add('DELETE', '/admin/guests/log', async (req, res) => {
        const a = admin(req, res);
        if (!a) return;
        req.resume();
        sendJson(res, 200, await a.guests.clearLog.execute({ actor: a.actor }));
      })
  );
}

/** The QR code's link: next to the Administration page the person has open (?base=), or this host. */
function guestLink(req: IncomingMessage, secure: boolean, key: string): string {
  const host = req.headers.host ?? '';
  let base = `${secure ? 'https' : 'http'}://${host}/`;
  const asked = new URL(req.url ?? '/', 'http://x').searchParams.get('base') ?? '';
  try {
    const u = new URL(asked);
    if (/^https?:$/.test(u.protocol) && u.host === host) base = u.href;
  } catch {
    // No base, or not a link: this host.
  }
  const u = new URL('guest.html', base);
  u.searchParams.set('k', key);
  return u.href;
}
