import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOCAL_OWNER } from '#application/accounts/identity.ts';
import { IdentifyLocalOwner } from '#application/accounts/identify-local-owner.ts';
import { setUpAccounts } from './fixtures.ts';

describe('the first administrator', () => {
  it('comes from BINDER_PASSWORD, once', async () => {
    const t = setUpAccounts();
    assert.deepEqual(await t.use.bootstrap.execute({ envPassword: 'short' }), { ok: false, error: { code: 'ENV_PASSWORD_TOO_SHORT', min: 8 } });
    assert.deepEqual(await t.use.bootstrap.execute({ envPassword: 'start password 1' }), { ok: true, value: { setupCode: null } });
    assert.deepEqual(t.logged.auth, ['Created the administrator "admin" with the password from BINDER_PASSWORD. Sign in, then add your own account or change the password.']);
    assert.deepEqual(await t.use.bootstrap.execute({ envPassword: 'another password' }), { ok: true, value: { setupCode: null } });
    const { users } = await t.use.listPeople.execute();
    assert.deepEqual(users.map((u) => [u.username, u.role, u.hasPassword]), [['admin', 'admin', true]]);
    assert.equal(await t.use.envPasswordWorks.execute({ envPassword: 'start password 1' }), true);
    assert.equal(await t.use.envPasswordWorks.execute({ envPassword: 'another password' }), false);
  });

  it('or, without it, from the one-time setup code', async () => {
    const t = setUpAccounts();
    const boot = await t.use.bootstrap.execute({});
    assert.ok(boot.ok && boot.value.setupCode);
    const setupCode = boot.value.setupCode;
    assert.deepEqual(await t.use.status.execute(), { setupRequired: true });
    const input = { username: 'Ash', name: 'Ash', password: 'pallet town 99', ...t.where };
    assert.deepEqual(await t.use.setUpFirstAdmin.execute({ ...input, setupCode: 'WRONG' }), { ok: false, error: { code: 'WRONG_SETUP_CODE' } });
    assert.deepEqual(t.logged.security, ['Wrong first-run setup code']);
    const done = await t.use.setUpFirstAdmin.execute({ ...input, setupCode: ` ${setupCode.toLowerCase()} ` });
    assert.ok(done.ok);
    assert.deepEqual(await t.use.status.execute(), { setupRequired: false });
    const me = await t.use.identify.execute({ sessionToken: done.value.token });
    assert.deepEqual(me.identity, { id: me.identity?.id, name: 'ash', displayName: 'Ash', role: 'admin', via: 'session' });
    assert.deepEqual(await t.use.setUpFirstAdmin.execute({ ...input, username: 'eve', setupCode }), { ok: false, error: { code: 'ALREADY_SET_UP' } });
  });
});

describe('signing in', () => {
  it('starts a session the browser keeps for the maximum age', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const r = await t.use.signIn.execute({ username: ' ADMIN ', password: 'start password 1', ...t.where });
    assert.ok(r.ok && r.value.status === 'ok');
    assert.equal(r.value.maxAgeDays, 30);
    const me = await t.use.identify.execute({ sessionToken: r.value.token });
    assert.equal(me.identity?.name, 'admin');
    assert.match(t.logged.auth.at(-1) ?? '', /^admin signed in$/);
    assert.ok((await t.use.listPeople.execute()).users[0]?.lastSignInAt);
  });

  it('checks one password per attempt, whether or not the username exists', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    for (const [username, password] of [['nobody', 'the wrong password'], ['admin', 'the wrong password'], ['admin', 'start password 1']]) {
      const before = t.hasher.checks;
      await t.use.signIn.execute({ username: username ?? '', password: password ?? '', ...t.where });
      assert.equal(t.hasher.checks - before, 1);
    }
  });

  it('locks a username after repeated wrong passwords, twice as long each time', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const wrong = () => t.use.signIn.execute({ username: 'admin', password: 'nope', ...t.where });
    for (let i = 0; i < 5; i++) assert.deepEqual(await wrong(), { ok: false, error: { code: 'WRONG_PASSWORD' } });
    assert.deepEqual(await wrong(), { ok: false, error: { code: 'LOCKED', minutes: 1 } });
    assert.ok((await t.use.listPeople.execute()).users[0]?.lockedUntil);
    t.clock.at += 61_000;
    for (let i = 0; i < 5; i++) await wrong();
    assert.deepEqual(await wrong(), { ok: false, error: { code: 'LOCKED', minutes: 2 } });
    assert.deepEqual(t.logged.security, ['Locked the username "admin" for 1 minutes after repeated wrong passwords', 'Locked the username "admin" for 2 minutes after repeated wrong passwords']);
    assert.equal(t.logged.auth.filter((m) => m === 'Failed sign-in for "admin"').length, 10);
    t.clock.at += 121_000;
    assert.equal((await t.use.signIn.execute({ username: 'admin', password: 'start password 1', ...t.where })).ok, true);
  });

  it('makes someone with a temporary password choose their own, and signs them out elsewhere', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    await t.add('gary', 'editor', { password: 'temporary pass 1', mustChange: true });
    assert.deepEqual(await t.use.signIn.execute({ username: 'gary', password: 'temporary pass 1', ...t.where }), { ok: true, value: { status: 'change' } });
    const change = (newPassword: string) => t.use.changeOwnPassword.execute({ username: 'gary', currentPassword: 'temporary pass 1', newPassword, ...t.where });
    assert.deepEqual(await change('gary'), { ok: false, error: { code: 'PASSWORD_TOO_SHORT', min: 10 } });
    assert.deepEqual(await change('password123'), { ok: false, error: { code: 'PASSWORD_TOO_EASY' } });
    assert.deepEqual(await change('temporary pass 1'), { ok: false, error: { code: 'SAME_PASSWORD' } });
    const done = await change('smell ya later 7');
    assert.ok(done.ok);
    assert.equal((await t.use.identify.execute({ sessionToken: done.value.token })).identity?.name, 'gary');
    assert.equal((await t.use.listPeople.execute()).users.find((u) => u.username === 'gary')?.mustChange, false);
    assert.equal(t.logged.auth.at(-1), 'gary changed their password');
  });

  it('refuses passwords over 200 characters before checking them', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    assert.deepEqual(await t.use.signIn.execute({ username: 'admin', password: 'x'.repeat(201), ...t.where }), { ok: false, error: { code: 'PASSWORD_TOO_LONG' } });
    assert.equal(t.hasher.checks, 0);
  });
});

describe('who is calling', () => {
  it('is the person behind a session, until it is idle too long or they sign out', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const token = await t.signIn('admin', 'start password 1');
    assert.equal((await t.use.identify.execute({ sessionToken: token })).identity?.via, 'session');
    t.clock.at += 13 * 86_400_000;
    assert.ok((await t.use.identify.execute({ sessionToken: token })).identity);
    t.clock.at += 13 * 86_400_000; // used 13 days ago: still within the 14 idle days
    assert.ok((await t.use.identify.execute({ sessionToken: token })).identity);
    t.clock.at += 15 * 86_400_000;
    assert.deepEqual(await t.use.identify.execute({ sessionToken: token }), { identity: null, badToken: false });
    assert.equal((await t.sessions.list()).length, 0);
    const again = await t.signIn('admin', 'start password 1');
    await t.use.signOut.execute({ token: again });
    assert.equal((await t.use.identify.execute({ sessionToken: again })).identity, null);
  });

  it('saves when a session was last used now and then, not on every request', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const token = await t.signIn('admin', 'start password 1');
    const saves = t.sessions.saves;
    await t.use.identify.execute({ sessionToken: token });
    await t.use.identify.execute({ sessionToken: token });
    assert.equal(t.sessions.saves, saves);
    await t.sessions.flush();
    assert.equal(t.sessions.saves, saves + 1);
  });

  it('is an API token acting as its person, with a role no higher than its scope', async () => {
    const t = setUpAccounts();
    await t.withAdmin();
    const me = (await t.use.listPeople.execute()).users[0];
    assert.ok(me);
    const read = await t.use.createToken.execute({ actor: 'admin', name: 'reader', userId: me.id, scope: 'read', expiresInDays: 1 });
    const write = await t.use.createToken.execute({ actor: 'admin', name: 'writer', userId: me.id, scope: 'write', expiresInDays: 90 });
    assert.ok(read.ok && write.ok);
    assert.match(read.value.token, /^binder_/);
    assert.deepEqual(await t.use.identify.execute({ bearer: read.value.token }), { identity: { id: me.id, name: 'admin', displayName: 'Administrator', role: 'viewer', via: 'token' }, badToken: false });
    assert.equal((await t.use.identify.execute({ bearer: write.value.token })).identity?.role, 'editor');
    assert.deepEqual(await t.use.identify.execute({ bearer: 'binder_forged' }), { identity: null, badToken: true });
    // A token is tried even alongside a session cookie.
    assert.equal((await t.use.identify.execute({ bearer: 'binder_forged', sessionToken: await t.signIn('admin', 'start password 1') })).badToken, true);
    const listed = (await t.use.listTokens.execute()).tokens;
    assert.ok(listed.every((tk) => !('hash' in tk) && tk.user === 'admin' && !tk.expired));
    assert.ok(listed.find((tk) => tk.name === 'reader')?.lastUsedAt);
    assert.equal(JSON.stringify(listed).includes(write.value.token), false);
    assert.equal((await t.use.revokeToken.execute({ actor: 'admin', id: write.value.id })).ok, true);
    assert.equal((await t.use.identify.execute({ bearer: write.value.token })).badToken, true);
    t.clock.at += 2 * 86_400_000;
    assert.equal((await t.use.identify.execute({ bearer: read.value.token })).badToken, true);
    assert.equal((await t.use.listTokens.execute()).tokens[0]?.expired, true);
  });

  it('is the local owner with sign-in turned off', async () => {
    assert.deepEqual(await new IdentifyLocalOwner().execute({ bearer: 'anything' }), { identity: LOCAL_OWNER, badToken: false });
  });
});
