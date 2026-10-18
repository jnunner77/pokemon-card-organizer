import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setUpAccounts } from './fixtures.ts';

describe('administering people', () => {
  it('adds people, never two with one username, and never with a weak password', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const misty = await t.add('Misty', 'viewer');
    assert.equal(misty.username, 'misty');
    assert.equal('passwordHash' in misty, false);
    assert.equal(misty.hasPassword, true);
    const again = await t.use.createPerson.execute({ actor: 'admin', username: 'misty', name: 'M', role: 'viewer', password: 'a good password', mustChange: true });
    assert.deepEqual(again, { ok: false, error: { code: 'USERNAME_TAKEN', username: 'misty' } });
    assert.deepEqual(await t.use.createPerson.execute({ actor: 'admin', username: 'brock', name: 'Brock', role: 'editor', password: 'brock', mustChange: true }), { ok: false, error: { code: 'PASSWORD_TOO_SHORT', min: 10 } });
    assert.deepEqual(await t.use.createPerson.execute({ actor: 'admin', username: 'x', name: 'X', role: 'editor', password: 'a good password', mustChange: true }), { ok: false, error: { code: 'INVALID_USERNAME' } });
    assert.deepEqual(t.logged.admin, ['admin added misty (viewer)']);
  });

  it('turning someone off signs them out; the last administrator stays one', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const tracey = await t.add('tracey', 'editor');
    const token = await t.signIn('tracey', 'a good password');
    const off = await t.use.updatePerson.execute({ actor: 'admin', id: tracey.id, active: false });
    assert.ok(off.ok && !off.value.active);
    assert.equal((await t.use.identify.execute({ sessionToken: token })).identity, null);
    assert.equal(t.logged.admin.at(-1), 'admin changed tracey');
    const admin = (await t.use.listPeople.execute()).users.find((u) => u.username === 'admin');
    assert.ok(admin);
    assert.deepEqual(await t.use.updatePerson.execute({ actor: 'admin', id: admin.id, role: 'editor' }), { ok: false, error: { code: 'LAST_ADMIN' } });
    assert.deepEqual(await t.use.deletePerson.execute({ actor: 'admin', id: admin.id }), { ok: false, error: { code: 'LAST_ADMIN' } });
    assert.deepEqual(await t.use.updatePerson.execute({ actor: 'admin', id: 'nobody', name: 'x' }), { ok: false, error: { code: 'PERSON_NOT_FOUND' } });
    assert.deepEqual(await t.use.updatePerson.execute({ actor: 'admin', id: tracey.id, name: ' ' }), { ok: false, error: { code: 'NAME_MISSING' } });
  });

  it('a new password from an administrator lifts a lock and signs the person out', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const ash = await t.add('ash', 'viewer');
    const token = await t.signIn('ash', 'a good password');
    for (let i = 0; i < 5; i++) await t.use.signIn.execute({ username: 'ash', password: 'nope', ...t.where });
    const set = await t.use.setPersonPassword.execute({ actor: 'admin', id: ash.id, password: 'a new password 2', mustChange: false });
    assert.ok(set.ok);
    assert.equal(set.value.lockedUntil, null);
    assert.equal((await t.use.identify.execute({ sessionToken: token })).identity, null);
    assert.ok(await t.signIn('ash', 'a new password 2'));
    assert.equal(t.logged.admin.at(-1), 'admin set a new password for ash');
  });

  it('signs people out, lists and ends sessions, and removes people with their tokens', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const brock = await t.add('brock', 'editor');
    await t.signIn('brock', 'a good password');
    await t.signIn('brock', 'a good password');
    const mine = await t.signIn('admin', 'start password 1');
    const { sessions } = await t.use.listSessions.execute();
    assert.deepEqual(sessions.map((s) => s.user).sort(), ['admin', 'brock', 'brock']);
    assert.deepEqual(await t.use.signPersonOut.execute({ actor: 'admin', id: brock.id }), { signedOut: 2 });
    assert.equal(t.logged.admin.at(-1), 'admin signed a person out of 2 sessions');
    const adminSession = (await t.use.listSessions.execute()).sessions[0];
    assert.ok(adminSession);
    await t.use.endSession.execute({ actor: 'admin', id: adminSession.id });
    assert.equal((await t.use.identify.execute({ sessionToken: mine })).identity, null);
    const token = await t.use.createToken.execute({ actor: 'admin', name: 'bot', userId: brock.id, scope: 'write', expiresInDays: 30 });
    assert.ok(token.ok);
    assert.deepEqual(await t.use.deletePerson.execute({ actor: 'admin', id: brock.id }), { ok: true, value: undefined });
    assert.deepEqual((await t.use.listTokens.execute()).tokens, []);
    assert.equal(t.logged.admin.at(-1), 'admin removed brock');
  });

  it('makes tokens only for active people, and changes sign-in settings within their limits', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const misty = await t.add('misty', 'viewer');
    await t.use.updatePerson.execute({ actor: 'admin', id: misty.id, active: false });
    assert.deepEqual(await t.use.createToken.execute({ actor: 'admin', name: 'x', userId: misty.id, scope: 'read', expiresInDays: 90 }), { ok: false, error: { code: 'PERSON_INACTIVE', username: 'misty' } });
    assert.deepEqual(await t.use.createToken.execute({ actor: 'admin', name: 'x', userId: 'nobody', scope: 'read', expiresInDays: 90 }), { ok: false, error: { code: 'PERSON_NOT_FOUND' } });
    assert.deepEqual(await t.use.createToken.execute({ actor: 'admin', name: ' ', userId: misty.id, scope: 'read', expiresInDays: 90 }), { ok: false, error: { code: 'TOKEN_NAME_MISSING' } });
    const changed = await t.use.changeSettings.execute({ actor: 'admin', change: { passwordMinLength: 12 } });
    assert.ok(changed.ok && changed.value.passwordMinLength === 12);
    assert.equal(t.logged.admin.at(-1), 'admin changed sign-in settings');
    assert.deepEqual(await t.use.changeSettings.execute({ actor: 'admin', change: { lockoutAfter: 2 } }), { ok: false, error: { code: 'INVALID_SETTING', message: 'lockoutAfter: Too small: at least 3' } });
  });

  it('reports on accounts for the Overview', async () => {
    const t = setUpAccounts();
    assert.equal((await t.use.health.execute()).setupPending, false);
    await t.use.bootstrap.execute({});
    assert.equal((await t.use.health.execute()).setupPending, true);
    const u = setUpAccounts();
    await u.withAdmin();
    await u.add('misty', 'admin', { mustChange: true });
    await u.signIn('admin', 'start password 1');
    const admin = (await u.use.listPeople.execute()).users[0];
    assert.ok(admin);
    await u.use.createToken.execute({ actor: 'admin', name: 'old', userId: admin.id, scope: 'read', expiresInDays: 1 });
    u.clock.at += 2 * 86_400_000;
    assert.deepEqual(await u.use.health.execute(), { users: 2, admins: 2, adminsMustChange: 1, settings: (await u.use.listPeople.execute()).settings, sessions: 1, tokens: 1, tokensExpired: 1, tokensStale: 0, setupPending: false });
  });
});
