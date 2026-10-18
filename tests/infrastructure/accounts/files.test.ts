import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { addPerson } from '#domain/accounts/account-book.ts';
import { DEFAULT_SIGN_IN_SETTINGS } from '#domain/accounts/settings.ts';
import { FileAccountStore } from '#infrastructure/accounts/auth-file.ts';
import { ScryptHasher } from '#infrastructure/accounts/scrypt-hasher.ts';
import { FileSessionStore } from '#infrastructure/accounts/session-file.ts';
import { NodeSecrets } from '#infrastructure/node-secrets.ts';
import { err, ok } from '#shared/result.ts';

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-accounts-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const privateFile = (file: string) => (fs.statSync(file).mode & 0o077) === 0;
const person = { id: 'u1', username: 'ash', name: 'Ash', role: 'admin' as const, active: true, passwordHash: 'h', passwordSetAt: null, mustChange: false, createdAt: '2026-10-18T12:00:00.000Z', lastSignInAt: null };

describe('FileAccountStore', () => {
  it('keeps people in auth.json, readable only by the server, and saves only changes that succeed', async () => {
    const dir = tempDir();
    const store = new FileAccountStore(dir);
    assert.deepEqual(await store.read(), { settings: DEFAULT_SIGN_IN_SETTINGS, users: [], tokens: [] });
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    assert.deepEqual(await store.change((d) => addPerson(d, person)), ok(person));
    assert.ok(privateFile(path.join(dir, 'auth.json')));
    assert.deepEqual(await store.change((d) => (addPerson(d, { ...person, id: 'u2', username: 'misty' }), err('nope'))), err('nope'));
    assert.deepEqual((await new FileAccountStore(dir).read()).users, [person]);
  });

  it('fills in settings missing from an older auth.json', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ settings: { lockoutAfter: 7 }, users: [person] }));
    assert.deepEqual(await new FileAccountStore(dir).read(), { settings: { ...DEFAULT_SIGN_IN_SETTINGS, lockoutAfter: 7 }, users: [person], tokens: [] });
  });

  it('refuses to start from a damaged auth.json, and leaves it where it is', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'auth.json'), '{"users": [');
    assert.throws(() => new FileAccountStore(dir), /auth\.json was damaged .*won't start without its accounts/);
    assert.deepEqual(fs.readdirSync(dir), ['auth.json']);
  });
});

describe('FileSessionStore', () => {
  const session = { id: 's1', hash: 'h1', userId: 'u1', createdAt: 1, lastSeen: 1, ip: '', agent: '' };

  it('saves sessions as they start and end, and last use only when flushed', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'sessions.json');
    const sessions = new FileSessionStore(dir, () => assert.fail('not damaged'));
    await sessions.add(session);
    assert.ok(privateFile(file));
    await sessions.touch('h1', 5);
    assert.equal((await new FileSessionStore(dir, () => {}).find('h1'))?.lastSeen, 1);
    await sessions.flush();
    assert.equal((await new FileSessionStore(dir, () => {}).find('h1'))?.lastSeen, 5);
    assert.equal(await sessions.remove((s) => s.userId === 'u2'), 0);
    assert.equal(await sessions.remove((s) => s.userId === 'u1'), 1);
    assert.deepEqual(await new FileSessionStore(dir, () => {}).list(), []);
  });

  it('sets a damaged sessions.json aside: everyone signs in again', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{"sessions": [');
    const told: string[] = [];
    const sessions = new FileSessionStore(dir, (m) => told.push(m));
    assert.deepEqual(await sessions.list(), []);
    assert.match(told[0] ?? '', /^sessions\.json was damaged .*Everyone needs to sign in again\.$/);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('sessions.json.damaged-')).length, 1);
  });
});

describe('ScryptHasher', () => {
  it('hashes with scrypt and a random salt, and checks passwords against the hash', async () => {
    const hasher = new ScryptHasher();
    const hash = await hasher.hash('start password 1');
    assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.notEqual(await hasher.hash('start password 1'), hash);
    assert.equal(await hasher.verify('start password 1', hash), true);
    assert.equal(await hasher.verify('start password 2', hash), false);
    assert.equal(await hasher.verify('start password 1', 'bcrypt$whatever'), false);
    // Without a hash (no such person) the answer is no, after the same work.
    assert.equal(await hasher.verify('start password 1', null), false);
  });
});

describe('NodeSecrets', () => {
  it('makes random secrets in their formats, and compares them by their hashes', () => {
    const s = new NodeSecrets();
    assert.match(s.id(), /^[0-9a-f]{16}$/);
    assert.match(s.sessionToken(), /^[A-Za-z0-9_-]{43}$/);
    assert.match(s.apiToken('binder_'), /^binder_[A-Za-z0-9_-]{32}$/);
    assert.match(s.setupCode(), /^[0-9A-F]{10}$/);
    assert.match(s.guestKey(), /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(s.sessionToken(), s.sessionToken());
    assert.match(s.digest('x'), /^[0-9a-f]{64}$/);
    assert.equal(s.same('ABC', 'ABC'), true);
    assert.equal(s.same('ABC', 'ABCD'), false);
  });
});
