import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Identity } from '#application/accounts/identity.ts';
import { accountRoutes, SESSION_COOKIE } from '#presentation/accounts/routes.ts';
import type { ClientResolver } from '#presentation/http/client.ts';
import { setUpAccounts } from '../../application/accounts/fixtures.ts';
import { body, json, serve } from '../fixtures.ts';

/** The routes over the real use cases in memory. Who is calling comes from the session cookie, as the request pipeline would work it out. */
async function setUp(o: { off?: boolean; secure?: boolean } = {}) {
  const t = setUpAccounts();
  await t.withAdmin();
  const identities = new WeakMap<object, Identity | null>();
  const client: ClientResolver = () => ({ ip: '1.2.3.4', secure: o.secure ?? false });
  const routes = accountRoutes({
    identify: (req) => identities.get(req) ?? null,
    client,
    accounts: o.off ? null : { ...t.use, status: t.use.status },
  });
  const base = await serve(async (req, res) => {
    const cookie = /binder_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const role = req.headers['x-role'];
    const local: Identity | null = role === 'admin' || role === 'editor' || role === 'viewer' ? { id: 'local', name: 'local', displayName: 'Local', role, via: 'session' } : null;
    identities.set(req, local ?? (await t.use.identify.execute({ sessionToken: cookie })).identity);
    return routes.handle(req, res);
  });
  const signIn = async (username: string, password: string) => {
    const r = await fetch(`${base}/auth/login`, json({ username, password }));
    assert.equal(r.status, 200);
    return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };
  return { t, base, signIn };
}

describe('signing in', () => {
  it('sets an HttpOnly, SameSite=Lax session cookie, Secure behind HTTPS, kept for the maximum age', async () => {
    const { base } = await setUp({ secure: true });
    const r = await fetch(`${base}/auth/login`, json({ username: 'admin', password: 'start password 1' }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
    assert.match(r.headers.get('set-cookie') ?? '', new RegExp(`^${SESSION_COOKIE}=[^;]+; Max-Age=2592000; Path=/; Expires=[^;]+ GMT; HttpOnly; Secure; SameSite=Lax$`));
    const plain = await setUp();
    const r2 = await fetch(`${plain.base}/auth/login`, json({ username: 'admin', password: 'start password 1' }));
    assert.doesNotMatch(r2.headers.get('set-cookie') ?? '', /Secure/);
  });

  it('answers who is signed in, and signs out', async () => {
    const { base, signIn } = await setUp();
    assert.deepEqual(await (await fetch(`${base}/auth/me`)).json(), { authEnabled: true, setupRequired: false, user: null });
    const cookie = await signIn('admin', 'start password 1');
    assert.deepEqual(await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json(), { authEnabled: true, setupRequired: false, user: { username: 'admin', name: 'Administrator', role: 'admin', via: 'session' } });
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(out.status, 204);
    assert.equal(out.headers.get('set-cookie'), `${SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    assert.equal((await body(await fetch(`${base}/auth/me`, { headers: { cookie } }))).user, null);
  });

  it('answers wrong passwords, locks with Retry-After, and someone who must choose a new password without a cookie', async () => {
    const { t, base } = await setUp();
    const wrong = () => fetch(`${base}/auth/login`, json({ username: 'admin', password: 'nope' }));
    for (let i = 0; i < 5; i++) assert.deepEqual(await (await wrong()).json(), { error: 'Wrong username or password.', code: 'signin' });
    const locked = await wrong();
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '60');
    assert.deepEqual(await locked.json(), { error: 'Too many wrong passwords. Try again in 1 minute.', code: 'rate_limited' });
    await t.add('gary', 'editor', { password: 'temporary pass 1', mustChange: true });
    const change = await fetch(`${base}/auth/login`, json({ username: 'gary', password: 'temporary pass 1' }));
    assert.deepEqual(await change.json(), { status: 'change' });
    assert.equal(change.headers.get('set-cookie'), null);
    const changed = await fetch(`${base}/auth/password`, json({ username: 'gary', currentPassword: 'temporary pass 1', newPassword: 'smell ya later 7' }));
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie') ?? '', /^binder_session=/);
  });

  it('checks the request: only the fields each route takes, of the right kinds', async () => {
    const { base } = await setUp();
    const answer = async (body: unknown) => (await fetch(`${base}/auth/login`, json(body))).json();
    assert.deepEqual(await answer({ username: 'admin' }), { error: 'password: Required', code: 'invalid_argument' });
    assert.deepEqual(await answer({ username: 'admin', password: 'x', extra: 1 }), { error: 'Unrecognized field "extra"', code: 'invalid_argument' });
    assert.deepEqual(await answer({ username: 7, password: 'x' }), { error: 'username: Expected text', code: 'invalid_argument' });
    assert.deepEqual(await answer({ username: 'x'.repeat(65), password: 'x' }), { error: 'username: Too big: at most 64 characters', code: 'invalid_argument' });
    assert.deepEqual(await answer({ username: 'admin', password: 'x'.repeat(201) }), { error: 'Passwords can be at most 200 characters', code: 'invalid_argument' });
    assert.deepEqual(await answer([]), { error: 'Expected an object', code: 'invalid_argument' });
    const bad = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":' });
    assert.deepEqual(await bad.json(), { error: "The request body isn't valid JSON", code: 'invalid_argument' });
  });
});

describe('administering people', () => {
  it('is for administrators only, refused before the request is read', async () => {
    const { base } = await setUp();
    const malformed = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' };
    const asEditor = await fetch(`${base}/admin/users`, { ...malformed, headers: { ...malformed.headers, 'X-Role': 'editor' } });
    assert.equal(asEditor.status, 403);
    assert.deepEqual(await asEditor.json(), { error: 'Only administrators can do this.', code: 'forbidden' });
    assert.equal((await fetch(`${base}/admin/users`, malformed)).status, 401);
    for (const [method, path] of [['GET', '/admin/sessions'], ['GET', '/admin/tokens'], ['PUT', '/admin/settings'], ['DELETE', '/admin/tokens/x'], ['PATCH', '/admin/users/x']] as const) {
      assert.equal((await fetch(`${base}${path}`, { method, headers: { 'X-Role': 'viewer' } })).status, 403, `${method} ${path}`);
    }
  });

  it('adds, changes and removes people, with the same answers as before', async () => {
    const { base } = await setUp();
    const admin = (init: RequestInit) => ({ ...init, headers: { ...init.headers, 'X-Role': 'admin' } });
    const added = await fetch(`${base}/admin/users`, admin(json({ username: 'Misty', name: 'Misty', role: 'viewer', password: 'a good password' })));
    assert.equal(added.status, 201);
    const misty = await body(added);
    assert.deepEqual([misty.username, misty.mustChange, misty.hasPassword, 'passwordHash' in misty], ['misty', true, true, false]);
    const taken = await fetch(`${base}/admin/users`, admin(json({ username: 'misty', name: 'M', role: 'viewer', password: 'a good password' })));
    assert.deepEqual(await taken.json(), { error: 'The username "misty" is taken.', code: 'invalid_argument' });
    const badRole = await fetch(`${base}/admin/users`, admin(json({ username: 'brock', name: 'B', role: 'owner', password: 'a good password' })));
    assert.deepEqual(await badRole.json(), { error: 'role: Expected one of viewer, editor, admin', code: 'invalid_argument' });
    const patched = await fetch(`${base}/admin/users/${misty.id}`, admin(json({ role: 'editor' }, 'PATCH')));
    assert.equal((await body(patched)).role, 'editor');
    const missing = await fetch(`${base}/admin/users/nobody`, admin(json({ name: 'x' }, 'PATCH')));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'No such person', code: 'not_found' });
    const weak = await fetch(`${base}/admin/users/${misty.id}/password`, admin(json({ password: 'misty' })));
    assert.deepEqual(await weak.json(), { error: 'Use at least 10 characters.', code: 'invalid_argument' });
    assert.deepEqual(await (await fetch(`${base}/admin/users/${misty.id}/signout`, admin({ method: 'POST' }))).json(), { signedOut: 0 });
    const settings = await fetch(`${base}/admin/settings`, admin(json({ lockoutAfter: 2 }, 'PUT')));
    assert.deepEqual(await settings.json(), { error: 'lockoutAfter: Too small: at least 3', code: 'invalid_argument' });
    assert.equal((await fetch(`${base}/admin/users/${misty.id}`, admin({ method: 'DELETE' }))).status, 204);
    const { users } = await body(await fetch(`${base}/admin/users`, admin({})));
    const me = users[0];
    const last = await fetch(`${base}/admin/users/${me.id}`, admin({ method: 'DELETE' }));
    assert.deepEqual(await last.json(), { error: 'Someone else must be an active administrator first.', code: 'invalid_argument' });
  });

  it('creates API tokens (read-only for 90 days unless asked) and revokes them', async () => {
    const { base } = await setUp();
    const admin = (init: RequestInit) => ({ ...init, headers: { ...init.headers, 'X-Role': 'admin' } });
    const { users } = await body(await fetch(`${base}/admin/users`, admin({})));
    const made = await fetch(`${base}/admin/tokens`, admin(json({ name: 'reader', userId: users[0].id })));
    assert.equal(made.status, 201);
    const { token, id } = await body(made);
    assert.match(token, /^binder_/);
    const listed = (await body(await fetch(`${base}/admin/tokens`, admin({})))).tokens;
    assert.deepEqual([listed[0].scope, listed[0].expiresAt, JSON.stringify(listed).includes(token)], ['read', '2027-01-16T12:00:00.000Z', false]);
    const days = await fetch(`${base}/admin/tokens`, admin(json({ name: 'x', userId: users[0].id, expiresInDays: 400 })));
    assert.deepEqual(await days.json(), { error: 'expiresInDays: Too big: at most 365', code: 'invalid_argument' });
    assert.equal((await fetch(`${base}/admin/tokens/${id}`, admin({ method: 'DELETE' }))).status, 204);
    assert.deepEqual(await (await fetch(`${base}/admin/tokens/${id}`, admin({ method: 'DELETE' }))).json(), { error: 'No such token', code: 'not_found' });
  });
});

describe('with sign-in turned off (AUTH=off)', () => {
  it('says so, has no sign-in routes, and has no people to administer', async () => {
    const { base } = await setUp({ off: true });
    assert.deepEqual(await (await fetch(`${base}/auth/me`, { headers: { 'X-Role': 'admin' } })).json(), { authEnabled: false, setupRequired: false, user: { username: 'local', name: 'Local', role: 'admin', via: 'session' } });
    assert.equal((await fetch(`${base}/auth/login`, json({ username: 'a', password: 'b' }))).status, 404);
    const people = await fetch(`${base}/admin/users`, { headers: { 'X-Role': 'admin' } });
    assert.deepEqual(await people.json(), { error: 'Sign-in is turned off on this server (AUTH=off).', code: 'invalid_argument' });
  });
});
