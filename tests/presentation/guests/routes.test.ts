import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import type { SignedInGuest } from '#application/guests/state.ts';
import type { DocumentView } from '#application/ledger/ledger-reader.ts';
import { ManualLedgerChanges } from '#infrastructure/memory/guests.ts';
import { GuestCardFeed } from '#presentation/guests/feed.ts';
import { GUEST_COOKIE, guestRoutes } from '#presentation/guests/routes.ts';
import { openGate, type StreamGate } from '#presentation/http/streams.ts';
import { setUpGuests } from '../../application/guests/fixtures.ts';
import { body, json, serve } from '../fixtures.ts';

const PHOTO = 'a'.repeat(32);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** The routes over the real use cases in memory; the guest comes from the cookie, as the request pipeline would work it out. */
async function setUp(o: { cards?: DocumentView[]; binders?: DocumentView[]; streams?: StreamGate; off?: boolean } = {}) {
  const cards = o.cards ?? [];
  const t = setUpGuests(cards, [], o.binders ?? []);
  const changes = new ManualLedgerChanges();
  const feed = new GuestCardFeed(() => t.use.listCards.execute(), changes, 20);
  const guests = new WeakMap<object, SignedInGuest | null>();
  const routes = guestRoutes({
    identify: (req) => {
      const role = req.headers['x-role'];
      return role === 'admin' || role === 'editor' ? { name: 'justin', role } : null;
    },
    guest: (req) => guests.get(req) ?? null,
    client: () => ({ ip: '10.0.0.1', secure: false }),
    streams: o.streams ?? openGate,
    guests: o.off ? null : { ...t.use, feed },
  });
  const base = await serve(async (req, res) => {
    const token = new RegExp(`${GUEST_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
    guests.set(req, await t.use.identify.execute({ token, touch: true }));
    return routes.handle(req, res);
  });
  const signIn = async (name: string, contact: string) => {
    const r = await fetch(`${base}/guest/login`, json({ key: 'the-key', name, contact }));
    assert.equal(r.status, 200, await r.clone().text());
    return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };
  return { t, base, signIn, changes, cards };
}

describe('the guest page', () => {
  it('signs a guest in with an HttpOnly session cookie, and out again', async () => {
    const { t, base } = await setUp();
    const closed = await fetch(`${base}/guest/login`, json({ key: 'the-key', name: 'Ash', contact: 'ash@pallet.town' }));
    assert.equal(closed.status, 403);
    assert.deepEqual(await closed.json(), { error: 'Guest viewing is closed right now.', code: 'guests_closed' });
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    const r = await fetch(`${base}/guest/login`, json({ key: 'the-key', name: 'Ash', contact: 'ash@pallet.town' }));
    assert.deepEqual(await r.json(), { guest: { name: 'Ash', contact: 'ash@pallet.town' } });
    const setCookie = r.headers.get('set-cookie') ?? '';
    assert.match(setCookie, new RegExp(`^${GUEST_COOKIE}=[^;]+; Path=/; HttpOnly; SameSite=Lax$`));
    const cookie = setCookie.split(';')[0] ?? '';
    const me = await (await fetch(`${base}/guest/me?k=the-key`, { headers: { cookie } })).json();
    assert.deepEqual(me, { open: true, keyOk: true, idleMinutes: 15, guest: { name: 'Ash', contact: 'ash@pallet.town', expiresAt: '2026-10-05T18:15:00.000Z' } });
    const out = await fetch(`${base}/guest/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(out.status, 204);
    assert.equal(out.headers.get('set-cookie'), `${GUEST_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    const after = await fetch(`${base}/guest/cards`, { headers: { cookie } });
    assert.equal(after.status, 401);
    assert.deepEqual(await after.json(), { error: 'Your guest visit ended. Sign in again to keep looking.', code: 'guest_signin' });
  });

  it('answers sign-in problems as before', async () => {
    const { t, base, signIn } = await setUp();
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    const answer = async (body: unknown) => (await fetch(`${base}/guest/login`, json(body))).json();
    assert.deepEqual(await answer({ key: 'old', name: 'Ash', contact: 'ash@pallet.town' }), { error: 'This QR code no longer works. Scan the one at the table.', code: 'guest_key' });
    assert.deepEqual(await answer({ key: 'the-key', name: ' ', contact: 'ash@pallet.town' }), { error: 'Enter your name', code: 'invalid_argument' });
    assert.deepEqual(await answer({ key: 'the-key', name: 'Ash', contact: 'ash@' }), { error: "That email doesn't look right.", code: 'invalid_argument' });
    assert.deepEqual(await answer({ name: 'Ash', contact: 'ash@pallet.town' }), { error: 'key: Required', code: 'invalid_argument' });
    await signIn('Ash', '604 555 0199');
    const taken = await fetch(`${base}/guest/login`, json({ key: 'the-key', name: 'Gary', contact: '6045550199' }));
    assert.equal(taken.status, 409);
    assert.deepEqual(await taken.json(), { error: 'Someone else is already looking with that phone number.', code: 'guest_taken' });
  });

  it('shows signed-in guests the listed cards and their pictures, kept for an hour', async () => {
    const { t, base, signIn } = await setUp({ cards: [{ id: 'c1', status: 'listed', name: 'Lapras', imageId: PHOTO }, { id: 'c2', status: 'listed', imageId: `data:image/png;base64,${Buffer.from('png').toString('base64')}` }, { id: 'kept', status: 'binder', imageId: PHOTO }] });
    await t.photos.save(PHOTO as never, JPEG);
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    assert.equal((await fetch(`${base}/guest/cards`)).status, 401);
    const cookie = await signIn('Ash', 'ash@pallet.town');
    const { cards } = await body(await fetch(`${base}/guest/cards`, { headers: { cookie } }));
    assert.deepEqual(cards.map((c: { id: string }) => c.id), ['c1', 'c2']);
    // Addresses are relative to the page; these routes are served without the /api prefix.
    const photo = await fetch(`${base}/${cards[0].image.replace(/^api\//, '')}`, { headers: { cookie } });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.equal(photo.headers.get('cache-control'), 'private, max-age=3600');
    const inline = await fetch(`${base}/guest/cards/c2/image`, { headers: { cookie } });
    assert.deepEqual([inline.headers.get('content-type'), inline.headers.get('cache-control'), await inline.text()], ['image/png', 'private, max-age=3600', 'png']);
    const kept = await fetch(`${base}/guest/cards/kept/image`, { headers: { cookie } });
    assert.deepEqual([kept.status, await kept.json()], [404, { error: 'No such picture', code: 'not_found' }]);
    assert.equal((await fetch(`${base}/guest/cards/c1/image`)).status, 401);
  });

  it('pushes the list again only when what guests see changes, and stops when the visit ends', async () => {
    const cards: DocumentView[] = [{ id: 'c1', status: 'listed' }];
    const { t, base, signIn, changes } = await setUp({ cards });
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    const cookie = await signIn('Ash', 'ash@pallet.town');
    const lists: string[][] = [];
    let ended = false;
    const res = await new Promise<http.IncomingMessage>((ok, bad) => http.get(`${base}/guest/events`, { headers: { cookie } }, ok).on('error', bad));
    assert.equal(res.headers['content-type'], 'text/event-stream');
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const data = /^data: (.*)$/m.exec(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (data?.[1]) lists.push(JSON.parse(data[1]).map((c: { id: string }) => c.id));
      }
    });
    res.on('end', () => (ended = true));
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(ok());
    };
    await until(() => lists.length === 1);
    changes.send({ collection: 'binders' });
    changes.send({ collection: 'cards' }); // nothing guests see changed
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(lists.length, 1);
    cards.push({ id: 'c2', status: 'listed' });
    changes.send({ collection: 'cards' });
    await until(() => lists.length === 2);
    assert.deepEqual(lists[1], ['c1', 'c2']);
    t.clock.at += 16 * 60_000;
    cards.pop();
    changes.send({ collection: 'cards' });
    await until(() => ended);
    assert.equal(lists.length, 2);
  });

  it('pushes the list again when a binder holding a listed card changes in a way guests can see', async () => {
    const binders: DocumentView[] = [{ id: 'b1', name: 'Trade', owner: 'Megan' }];
    const { t, changes } = await setUp({ cards: [{ id: 'c1', status: 'listed', binderId: 'b1', page: 1, slot: 2 }], binders });
    const feed = new GuestCardFeed(() => t.use.listCards.execute(), changes, 20);
    const lists: { place: { binder: string } | null }[][] = [];
    const stop = feed.subscribe((j) => lists.push(JSON.parse(j)));
    const settle = () => new Promise((r) => setTimeout(r, 80));
    const first = JSON.parse(await feed.current());
    assert.equal(first[0].place.binder, 'Trade');
    const edit = async (over: Record<string, unknown>) => {
      Object.assign(binders[0] ?? {}, over);
      changes.send({ collection: 'binders' });
      await settle();
    };
    await edit({ owner: 'Justin' });
    assert.equal(lists.length, 0);
    await edit({ name: 'Renamed' });
    assert.equal(lists.length, 1);
    assert.equal(lists[0]?.[0]?.place?.binder, 'Renamed');
    await edit({ hiddenFromGuests: true });
    assert.equal(lists.length, 2);
    assert.equal(lists[1]?.[0]?.place, null);
    await edit({ name: 'Renamed again' });
    assert.equal(lists.length, 2);
    stop();
  });

  it('refuses live updates past the connection limit, and to anyone but a signed-in guest', async () => {
    const refused: StreamGate = () => ({ refused: { status: 429, code: 'rate_limited', message: 'Too many open live-update connections. Close some tabs and reload.', retryAfter: 30 } });
    const { t, base, signIn } = await setUp({ streams: refused });
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    assert.equal((await fetch(`${base}/guest/events`)).status, 401);
    const r = await fetch(`${base}/guest/events`, { headers: { cookie: await signIn('Ash', 'ash@pallet.town') } });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '30');
  });
});

describe('administering guests', () => {
  it('is for administrators only, with the QR code linking next to the page they have open', async () => {
    const { t, base, signIn } = await setUp();
    assert.equal((await fetch(`${base}/admin/guests`, { headers: { 'X-Role': 'editor' } })).status, 403);
    assert.equal((await fetch(`${base}/admin/guests`, json({ enabled: true }, 'PUT'))).status, 401);
    assert.deepEqual(await (await fetch(`${base}/admin/guests`, { ...json({ enabled: true }, 'PUT'), headers: { 'Content-Type': 'application/json', 'X-Role': 'admin' } })).json(), { enabled: true });
    const host = new URL(base).host;
    const g = await body(await fetch(`${base}/admin/guests?base=${encodeURIComponent(`http://${host}/sub/admin.html`)}`, { headers: { 'X-Role': 'admin' } }));
    assert.equal(g.url, `http://${host}/sub/guest.html?k=the-key`);
    const evil = await body(await fetch(`${base}/admin/guests?base=${encodeURIComponent('https://evil.example/')}`, { headers: { 'X-Role': 'admin' } }));
    assert.equal(evil.url, `http://${host}/guest.html?k=the-key`);
    await signIn('Misty', 'misty@cerulean.gym');
    const { active } = await body(await fetch(`${base}/admin/guests`, { headers: { 'X-Role': 'admin' } }));
    assert.equal((await fetch(`${base}/admin/guests/sessions/${active[0].id}`, { method: 'DELETE', headers: { 'X-Role': 'admin' } })).status, 204);
    const gone = await fetch(`${base}/admin/guests/sessions/${active[0].id}`, { method: 'DELETE', headers: { 'X-Role': 'admin' } });
    assert.deepEqual([gone.status, await gone.json()], [404, { error: 'That guest is no longer signed in', code: 'not_found' }]);
    assert.equal((await fetch(`${base}/admin/guests/key`, { method: 'POST', headers: { 'X-Role': 'admin' } })).status, 204);
    assert.notEqual((await t.use.viewing.execute()).key, 'the-key');
    assert.deepEqual(await (await fetch(`${base}/admin/guests/log`, { method: 'DELETE', headers: { 'X-Role': 'admin' } })).json(), { removed: 1 });
    const bad = await fetch(`${base}/admin/guests`, { ...json({ enabled: 'yes' }, 'PUT'), headers: { 'Content-Type': 'application/json', 'X-Role': 'admin' } });
    assert.deepEqual(await bad.json(), { error: 'enabled: Expected true or false', code: 'invalid_argument' });
  });

  it('says so on a server without guest viewing, whose guest page has no routes', async () => {
    const { base } = await setUp({ off: true });
    assert.deepEqual(await (await fetch(`${base}/admin/guests`, { headers: { 'X-Role': 'admin' } })).json(), { error: 'Guest viewing is not available on this server.', code: 'invalid_argument' });
    assert.equal((await fetch(`${base}/guest/me`)).status, 404);
  });
});
