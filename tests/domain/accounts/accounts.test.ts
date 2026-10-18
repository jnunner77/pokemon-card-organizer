import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addPerson, changePerson, removePerson, removeToken, type AccountBook } from '#domain/accounts/account-book.ts';
import { isExpired, isStale, shouldNoteUse, tokenExpiry, tokenRole, readTokenName, type ApiToken } from '#domain/accounts/api-token.ts';
import { afterWrongPassword, lockedUntil, MAX_LOCK_MS, minutesLocked } from '#domain/accounts/lockout.ts';
import { checkNewPassword } from '#domain/accounts/password.ts';
import { readName, readPassword, readUsername, type Person } from '#domain/accounts/person.ts';
import { atLeast } from '#domain/accounts/role.ts';
import { isSessionLive } from '#domain/accounts/session.ts';
import { changeSettings, DEFAULT_SIGN_IN_SETTINGS } from '#domain/accounts/settings.ts';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const person = (over: Partial<Person> = {}): Person => ({ id: 'u1', username: 'ash', name: 'Ash', role: 'admin', active: true, passwordHash: 'h', passwordSetAt: null, mustChange: false, createdAt: NOW.toISOString(), lastSignInAt: null, ...over });
const book = (users: Person[], tokens: ApiToken[] = []): AccountBook => ({ settings: DEFAULT_SIGN_IN_SETTINGS, users, tokens });
const token = (over: Partial<ApiToken> = {}): ApiToken => ({ id: 't1', name: 'reader', userId: 'u1', scope: 'read', prefix: 'binder_abcde', hash: 'h', createdAt: NOW.toISOString(), createdBy: 'ash', expiresAt: '2026-11-18T12:00:00.000Z', lastUsedAt: null, ...over });

describe('people', () => {
  it('have usernames of 2–32 letters, digits, dots, dashes or underscores, in lower case', () => {
    assert.deepEqual(readUsername('  Ash.K '), { ok: true, value: 'ash.k' });
    for (const bad of ['a', 'ash ketchum', 'x'.repeat(33), 'ash!']) assert.deepEqual(readUsername(bad), { ok: false, error: { code: 'INVALID_USERNAME' } });
  });

  it('have a name of at most 80 characters, and passwords of at most 200', () => {
    assert.deepEqual(readName('  Ash  '), { ok: true, value: 'Ash' });
    assert.deepEqual(readName('   '), { ok: false, error: { code: 'NAME_MISSING' } });
    assert.deepEqual(readName('x'.repeat(81)), { ok: false, error: { code: 'NAME_TOO_LONG' } });
    assert.equal(readPassword('x'.repeat(200)).ok, true);
    assert.deepEqual(readPassword('x'.repeat(201)), { ok: false, error: { code: 'PASSWORD_TOO_LONG' } });
  });

  it('choose passwords that are long enough, not their username and not easy to guess', () => {
    assert.deepEqual(checkNewPassword('short', 'ash', 10), { ok: false, error: { code: 'PASSWORD_TOO_SHORT', min: 10 } });
    assert.deepEqual(checkNewPassword('GaryOakLab', 'garyoaklab', 10), { ok: false, error: { code: 'PASSWORD_IS_USERNAME' } });
    assert.deepEqual(checkNewPassword('password123', 'ash', 10), { ok: false, error: { code: 'PASSWORD_TOO_EASY' } });
    assert.deepEqual(checkNewPassword('aaaaaaaaaaaa', 'ash', 10), { ok: false, error: { code: 'PASSWORD_TOO_EASY' } });
    assert.deepEqual(checkNewPassword('smell ya later 7', 'gary', 10), { ok: true, value: 'smell ya later 7' });
  });

  it('rank roles: admin, then editor, then viewer', () => {
    assert.equal(atLeast('admin', 'editor'), true);
    assert.equal(atLeast('editor', 'editor'), true);
    assert.equal(atLeast('viewer', 'editor'), false);
  });
});

describe('the account book', () => {
  it('refuses a username that is taken', () => {
    const b = book([person()]);
    assert.deepEqual(addPerson(b, person({ id: 'u2' })), { ok: false, error: { code: 'USERNAME_TAKEN', username: 'ash' } });
    assert.equal(b.users.length, 1);
  });

  it('always keeps an active administrator who can sign in', () => {
    const b = book([person(), person({ id: 'u2', username: 'misty', role: 'viewer' })]);
    assert.deepEqual(changePerson(b, 'u1', { role: 'editor' }), { ok: false, error: { code: 'LAST_ADMIN' } });
    assert.deepEqual(changePerson(b, 'u1', { active: false }), { ok: false, error: { code: 'LAST_ADMIN' } });
    assert.deepEqual(removePerson(b, 'u1'), { ok: false, error: { code: 'LAST_ADMIN' } });
    // An administrator without a password can't sign in, so doesn't count.
    const withBlank = book([person(), person({ id: 'u3', username: 'brock', passwordHash: null })]);
    assert.equal(changePerson(withBlank, 'u1', { role: 'viewer' }).ok, false);
    // With another one, they can step down.
    const two = book([person(), person({ id: 'u3', username: 'brock' })]);
    assert.equal(changePerson(two, 'u1', { role: 'viewer', name: 'Ash K' }).ok, true);
    assert.deepEqual(two.users[0], person({ role: 'viewer', name: 'Ash K' }));
  });

  it('removes a person with their API tokens', () => {
    const b = book([person(), person({ id: 'u2', username: 'misty', role: 'viewer' })], [token({ userId: 'u2' }), token({ id: 't2' })]);
    assert.equal(removePerson(b, 'u2').ok, true);
    assert.deepEqual(b.tokens.map((t) => t.id), ['t2']);
    assert.deepEqual(removePerson(b, 'nobody'), { ok: false, error: { code: 'PERSON_NOT_FOUND' } });
    assert.deepEqual(removeToken(b, 'nope'), { ok: false, error: { code: 'TOKEN_NOT_FOUND' } });
  });
});

describe('sign-in settings', () => {
  it('change one at a time, whole numbers within their limits', () => {
    assert.deepEqual(changeSettings(DEFAULT_SIGN_IN_SETTINGS, { lockoutAfter: 3 }), { ok: true, value: { ...DEFAULT_SIGN_IN_SETTINGS, lockoutAfter: 3 } });
    assert.deepEqual(changeSettings(DEFAULT_SIGN_IN_SETTINGS, { passwordMinLength: 7 }), { ok: false, error: { code: 'INVALID_SETTING', message: 'passwordMinLength: Too small: at least 8' } });
    assert.deepEqual(changeSettings(DEFAULT_SIGN_IN_SETTINGS, { sessionMaxDays: 366 }), { ok: false, error: { code: 'INVALID_SETTING', message: 'sessionMaxDays: Too big: at most 365' } });
    assert.deepEqual(changeSettings(DEFAULT_SIGN_IN_SETTINGS, { lockoutMinutes: 1.5 }), { ok: false, error: { code: 'INVALID_SETTING', message: 'lockoutMinutes: Expected a whole number' } });
  });
});

describe('lockouts', () => {
  const settings = DEFAULT_SIGN_IN_SETTINGS;

  it('lock a username after repeated wrong passwords, twice as long each time', () => {
    let record = undefined;
    for (let i = 1; i < 5; i++) {
      const r = afterWrongPassword(record, settings, NOW);
      assert.equal(r.lockedMs, null);
      record = r.record;
    }
    const first = afterWrongPassword(record, settings, NOW);
    assert.equal(first.lockedMs, 60_000);
    assert.equal(minutesLocked(first.record, NOW), 1);
    assert.equal(lockedUntil(first.record, NOW), '2026-10-18T12:01:00.000Z');
    record = first.record;
    for (let i = 1; i < 5; i++) record = afterWrongPassword(record, settings, NOW).record;
    assert.equal(afterWrongPassword(record, settings, NOW).lockedMs, 120_000);
  });

  it('never lock for longer than a day', () => {
    const r = afterWrongPassword({ count: 4, locks: 20, lockedUntil: 0 }, settings, NOW);
    assert.equal(r.lockedMs, MAX_LOCK_MS);
    assert.equal(minutesLocked(r.record, new Date(NOW.getTime() + MAX_LOCK_MS)), 0);
  });
});

describe('sessions', () => {
  const session = { id: 's', hash: 'h', userId: 'u1', createdAt: NOW.getTime(), lastSeen: NOW.getTime(), ip: '', agent: '' };

  it('end after the idle time and after the maximum age', () => {
    const later = (ms: number) => new Date(NOW.getTime() + ms);
    assert.equal(isSessionLive(session, DEFAULT_SIGN_IN_SETTINGS, later(14 * 86_400_000 - 1)), true);
    assert.equal(isSessionLive(session, DEFAULT_SIGN_IN_SETTINGS, later(14 * 86_400_000)), false);
    const used = { ...session, lastSeen: later(29 * 86_400_000).getTime() };
    assert.equal(isSessionLive(used, DEFAULT_SIGN_IN_SETTINGS, later(30 * 86_400_000)), false);
  });
});

describe('API tokens', () => {
  it('read, or read and write unless the person only views; never admin', () => {
    assert.equal(tokenRole('read', 'admin'), 'viewer');
    assert.equal(tokenRole('write', 'admin'), 'editor');
    assert.equal(tokenRole('write', 'viewer'), 'viewer');
  });

  it('expire after 1 to 365 days, and note their use at most once a minute', () => {
    assert.deepEqual(tokenExpiry(90, NOW), { ok: true, value: '2027-01-16T12:00:00.000Z' });
    assert.deepEqual(tokenExpiry(0, NOW), { ok: false, error: { code: 'INVALID_TOKEN_DAYS', message: 'expiresInDays: Too small: at least 1' } });
    assert.deepEqual(tokenExpiry(366, NOW), { ok: false, error: { code: 'INVALID_TOKEN_DAYS', message: 'expiresInDays: Too big: at most 365' } });
    assert.equal(isExpired(token({ expiresAt: NOW.toISOString() }), NOW), true);
    assert.equal(shouldNoteUse(token(), NOW), true);
    assert.equal(shouldNoteUse(token({ lastUsedAt: '2026-10-18T11:59:30.000Z' }), NOW), false);
  });

  it('count as stale after 90 days unused', () => {
    assert.equal(isStale(token({ createdAt: '2026-07-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }), NOW), true);
    assert.equal(isStale(token({ createdAt: '2026-07-01T00:00:00.000Z', lastUsedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }), NOW), false);
  });

  it('have a name of at most 80 characters', () => {
    assert.deepEqual(readTokenName(' reader '), { ok: true, value: 'reader' });
    assert.deepEqual(readTokenName(' '), { ok: false, error: { code: 'TOKEN_NAME_MISSING' } });
    assert.deepEqual(readTokenName('x'.repeat(81)), { ok: false, error: { code: 'TOKEN_NAME_TOO_LONG' } });
  });
});
