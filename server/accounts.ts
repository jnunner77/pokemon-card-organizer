import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from './log';
import { HttpError } from './security';

// People who can use the ledger, their sign-in sessions and API tokens (modelled on Boards).
//
// - Roles: admin (everything, including the Administration pages), editor (changes the
//   ledger), viewer (looks only).
// - Passwords are hashed with scrypt; only the hash is kept, in <data>/auth.json, which never
//   reaches browsers or backups.
// - Wrong passwords lock the username after a few tries, for longer each time (1, 2, 4 … minutes,
//   up to a day).
// - Sessions are random tokens kept as hashes in <data>/sessions.json, so signing in survives
//   restarts; they end after a period without use and after a maximum age.
// - API tokens act as one person, read-only or read & write (never admin), always expire.
// - The first administrator comes from BINDER_PASSWORD (username "admin") or, without it, from
//   a one-time setup code written to the server log.

export type Role = 'admin' | 'editor' | 'viewer';
export const ROLES: Role[] = ['admin', 'editor', 'viewer'];
const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
export const atLeast = (role: Role, need: Role) => rank[role] >= rank[need];

export interface User {
  id: string;
  username: string;
  name: string;
  role: Role;
  active: boolean;
  passwordHash: string | null;
  passwordSetAt: string | null;
  mustChange: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface AuthSettings {
  /** Sign out after this long without using the ledger. */
  sessionIdleHours: number;
  /** Sign out after this long regardless. */
  sessionMaxDays: number;
  passwordMinLength: number;
  /** Wrong passwords in a row before the username is locked. */
  lockoutAfter: number;
  /** First lock length; each further lock doubles it, up to a day. */
  lockoutMinutes: number;
}

export const DEFAULT_SETTINGS: AuthSettings = { sessionIdleHours: 24 * 14, sessionMaxDays: 30, passwordMinLength: 10, lockoutAfter: 5, lockoutMinutes: 1 };

interface StoredToken {
  id: string;
  name: string;
  userId: string;
  scope: 'read' | 'write';
  prefix: string;
  hash: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

interface Session {
  id: string;
  hash: string;
  userId: string;
  createdAt: number;
  lastSeen: number;
  ip: string;
  agent: string;
}

interface AuthFile {
  settings: AuthSettings;
  users: User[];
  tokens: StoredToken[];
}

export interface Caller {
  user: User;
  /** The role this request may use: an API token's scope can lower it. */
  role: Role;
  via: 'session' | 'token';
  sessionId?: string;
  tokenId?: string;
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const DAY_MS = 86_400_000;
const MAX_LOCK_MS = DAY_MS;
const TOKEN_PREFIX = 'binder_';
export const SESSION_COOKIE = 'binder_session';
/** Very common passwords people reach for first. */
const COMMON = new Set(['password', 'password1', 'password123', '123456789', '1234567890', 'qwertyuiop', 'pokemon', 'pokemon123', 'pikachu', 'pikachu123', 'charizard', 'letmein123', 'iloveyou', 'admin12345', 'changeme', 'welcome123']);

function scrypt(password: string, salt: Buffer, p: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT.maxmem }, (e, key) => (e ? reject(e) : resolve(key))),
  );
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p), keylen: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,32}$/, 'Usernames are 2–32 letters, digits, dots, dashes or underscores');
const name = z.string().trim().min(1, 'Enter a name').max(80);
const password = z.string().max(200, 'Passwords can be at most 200 characters');

export const schemas = {
  login: z.object({ username: z.string().trim().max(64), password: password }).strict(),
  change: z.object({ username: z.string().trim().max(64), currentPassword: password, newPassword: password }).strict(),
  setup: z.object({ setupCode: z.string().trim().max(64), username, name, password }).strict(),
  createUser: z.object({ username, name, role: z.enum(ROLES), password, mustChange: z.boolean().default(true) }).strict(),
  updateUser: z.object({ name, role: z.enum(ROLES), active: z.boolean() }).partial().strict(),
  setPassword: z.object({ password, mustChange: z.boolean().default(true) }).strict(),
  settings: z
    .object({
      sessionIdleHours: z.number().int().min(1).max(24 * 90),
      sessionMaxDays: z.number().int().min(1).max(365),
      passwordMinLength: z.number().int().min(8).max(64),
      lockoutAfter: z.number().int().min(3).max(20),
      lockoutMinutes: z.number().int().min(1).max(60),
    })
    .partial()
    .strict(),
  createToken: z.object({ name: z.string().trim().min(1, 'Name the token').max(80), userId: z.string(), scope: z.enum(['read', 'write']).default('read'), expiresInDays: z.number().int().min(1).max(365).default(90) }).strict(),
};

export class Accounts {
  private data: AuthFile;
  private readonly file: string;
  private readonly sessionFile: string;
  private sessions = new Map<string, Session>();
  private readonly failures = new Map<string, { count: number; locks: number; lockedUntil: number }>();
  /** One-time code for creating the first administrator (only while there are no users). */
  setupCode: string | null = null;
  private sessionsDirty = false;
  private dummyHash: Promise<string> | null = null;

  constructor(
    dataDir: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'auth.json');
    this.sessionFile = path.join(dataDir, 'sessions.json');
    this.data = { settings: { ...DEFAULT_SETTINGS }, users: [], tokens: [] };
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AuthFile>;
      this.data = { settings: { ...DEFAULT_SETTINGS, ...raw.settings }, users: raw.users ?? [], tokens: raw.tokens ?? [] };
    }
    if (fs.existsSync(this.sessionFile)) {
      for (const s of (JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')) as { sessions?: Session[] }).sessions ?? []) this.sessions.set(s.hash, s);
    }
  }

  /** On start: create the first administrator from BINDER_PASSWORD, or issue a setup code. */
  async bootstrap(envPassword?: string) {
    if (this.data.users.length) return;
    if (envPassword) {
      if (envPassword.length < 8) throw new Error('BINDER_PASSWORD must be at least 8 characters');
      this.data.users.push({ id: newId(), username: 'admin', name: 'Administrator', role: 'admin', active: true, passwordHash: await hashPassword(envPassword), passwordSetAt: new Date(this.now()).toISOString(), mustChange: false, createdAt: new Date(this.now()).toISOString(), lastSignInAt: null });
      this.save();
      this.log.warn('auth', 'Created the administrator "admin" with the password from BINDER_PASSWORD. Sign in, then add your own account or change the password.');
      return;
    }
    this.setupCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    this.log.warn('auth', `No accounts yet. Open the ledger and create the first administrator with setup code ${this.setupCode}`);
    // Also print it plainly: the log entry above hides values that look secret.
    process.stdout.write(`\n  First-run setup code: ${this.setupCode}\n\n`);
  }

  get settings(): AuthSettings {
    return { ...this.data.settings };
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private saveSessions() {
    const tmp = `${this.sessionFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }), { mode: 0o600 });
    fs.renameSync(tmp, this.sessionFile);
    this.sessionsDirty = false;
  }

  /** Save last-seen times now and then rather than on every request. */
  flush() {
    if (this.sessionsDirty) this.saveSessions();
  }

  // ---- people ------------------------------------------------------------------------

  users() {
    return this.data.users.map((u) => this.view(u));
  }

  view(u: User) {
    const { passwordHash, ...rest } = u;
    const lock = this.failures.get(u.username);
    return { ...rest, hasPassword: !!passwordHash, sessions: [...this.sessions.values()].filter((s) => s.userId === u.id).length, lockedUntil: lock && lock.lockedUntil > this.now() ? new Date(lock.lockedUntil).toISOString() : null };
  }

  private user(id: string) {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) throw new HttpError(404, 'No such person', 'not_found');
    return u;
  }

  private activeAdmins(except?: string) {
    return this.data.users.filter((u) => u.active && u.role === 'admin' && u.passwordHash && u.id !== except);
  }

  checkPassword(pw: string, uname: string) {
    const min = this.data.settings.passwordMinLength;
    if (pw.length < min) throw new HttpError(400, `Use at least ${min} characters.`);
    if (pw.toLowerCase() === uname.toLowerCase()) throw new HttpError(400, "A password can't be the same as the username.");
    if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) throw new HttpError(400, 'That password is too easy to guess.');
  }

  async createUser(input: z.infer<typeof schemas.createUser>, by: string) {
    if (this.data.users.some((u) => u.username === input.username)) throw new HttpError(400, `The username "${input.username}" is taken.`);
    this.checkPassword(input.password, input.username);
    const at = new Date(this.now()).toISOString();
    const u: User = { id: newId(), username: input.username, name: input.name, role: input.role, active: true, passwordHash: await hashPassword(input.password), passwordSetAt: at, mustChange: input.mustChange, createdAt: at, lastSignInAt: null };
    this.data.users.push(u);
    this.save();
    this.log.info('admin', `${by} added ${u.username} (${u.role})`, { by, user: u.username, role: u.role });
    return this.view(u);
  }

  updateUser(id: string, patch: z.infer<typeof schemas.updateUser>, by: string) {
    const u = this.user(id);
    const losesAdmin = u.role === 'admin' && ((patch.role && patch.role !== 'admin') || patch.active === false);
    if (losesAdmin && !this.activeAdmins(u.id).length) throw new HttpError(400, 'Someone else must be an active administrator first.');
    Object.assign(u, patch);
    if (patch.active === false) this.revokeSessions(u.id);
    this.save();
    this.log.info('admin', `${by} changed ${u.username}`, { by, user: u.username, ...patch });
    return this.view(u);
  }

  deleteUser(id: string, by: string) {
    const u = this.user(id);
    if (u.role === 'admin' && !this.activeAdmins(u.id).length) throw new HttpError(400, 'Someone else must be an active administrator first.');
    this.data.users = this.data.users.filter((x) => x.id !== id);
    this.data.tokens = this.data.tokens.filter((t) => t.userId !== id);
    this.revokeSessions(id);
    this.save();
    this.log.info('admin', `${by} removed ${u.username}`, { by, user: u.username });
  }

  async setPassword(id: string, pw: string, mustChange: boolean, by: string) {
    const u = this.user(id);
    this.checkPassword(pw, u.username);
    u.passwordHash = await hashPassword(pw);
    u.passwordSetAt = new Date(this.now()).toISOString();
    u.mustChange = mustChange;
    this.failures.delete(u.username);
    this.revokeSessions(id);
    this.save();
    this.log.info('admin', `${by} set a new password for ${u.username}`, { by, user: u.username, mustChange });
    return this.view(u);
  }

  updateSettings(patch: z.infer<typeof schemas.settings>, by: string) {
    Object.assign(this.data.settings, patch);
    this.save();
    this.log.info('admin', `${by} changed sign-in settings`, { by, ...patch });
    return this.settings;
  }

  // ---- signing in --------------------------------------------------------------------

  private async wrong(uname: string) {
    // Same work as a real check, so a missing username takes as long as a wrong password.
    await verifyPassword('x', await (this.dummyHash ??= hashPassword(crypto.randomBytes(12).toString('hex'))));
    const s = this.data.settings;
    const f = this.failures.get(uname) ?? { count: 0, locks: 0, lockedUntil: 0 };
    f.count++;
    if (f.count >= s.lockoutAfter) {
      f.locks++;
      f.count = 0;
      const ms = Math.min(MAX_LOCK_MS, s.lockoutMinutes * 60_000 * 2 ** (f.locks - 1));
      f.lockedUntil = this.now() + ms;
      this.log.warn('security', `Locked the username "${uname}" for ${Math.round(ms / 60_000)} minutes after repeated wrong passwords`, { username: uname, minutes: Math.round(ms / 60_000), locks: f.locks });
    }
    this.failures.set(uname, f);
    return new HttpError(401, 'Wrong username or password.', 'signin');
  }

  private assertUnlocked(uname: string) {
    const f = this.failures.get(uname);
    if (f && f.lockedUntil > this.now()) {
      const mins = Math.ceil((f.lockedUntil - this.now()) / 60_000);
      throw new HttpError(429, `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'rate_limited', mins * 60);
    }
  }

  /** Check a username and password. Returns the person, or that they must choose a new password first. */
  async login(rawUser: string, pw: string, ip: string): Promise<{ status: 'ok'; user: User } | { status: 'change'; user: User }> {
    const uname = rawUser.trim().toLowerCase();
    this.assertUnlocked(uname);
    const u = this.data.users.find((x) => x.username === uname && x.active);
    if (!u || !u.passwordHash || !(await verifyPassword(pw, u.passwordHash))) {
      const err = await this.wrong(uname);
      this.log.warn('auth', `Failed sign-in for "${uname}"`, { username: uname, ip });
      throw err;
    }
    this.failures.delete(uname);
    if (u.mustChange) return { status: 'change', user: u };
    u.lastSignInAt = new Date(this.now()).toISOString();
    this.save();
    this.log.info('auth', `${u.username} signed in`, { username: u.username, ip });
    return { status: 'ok', user: u };
  }

  async changePassword(rawUser: string, current: string, next: string, ip: string) {
    const r = await this.login(rawUser, current, ip);
    if (next === current) throw new HttpError(400, 'Choose a password different from the current one.');
    this.checkPassword(next, r.user.username);
    r.user.passwordHash = await hashPassword(next);
    r.user.passwordSetAt = new Date(this.now()).toISOString();
    r.user.mustChange = false;
    r.user.lastSignInAt = r.user.passwordSetAt;
    this.revokeSessions(r.user.id);
    this.save();
    this.log.info('auth', `${r.user.username} changed their password`, { username: r.user.username, ip });
    return r.user;
  }

  /** Create the first administrator with the one-time setup code. */
  async setup(input: z.infer<typeof schemas.setup>, ip: string) {
    if (!this.setupCode || this.data.users.length) throw new HttpError(400, 'The ledger is already set up. Sign in instead.');
    const a = Buffer.from(sha256(input.setupCode.toUpperCase()));
    const b = Buffer.from(sha256(this.setupCode));
    if (!crypto.timingSafeEqual(a, b)) {
      this.log.warn('security', 'Wrong first-run setup code', { ip });
      throw new HttpError(401, 'That setup code is wrong. It is printed in the server log.', 'signin');
    }
    this.checkPassword(input.password, input.username);
    const at = new Date(this.now()).toISOString();
    const u: User = { id: newId(), username: input.username, name: input.name, role: 'admin', active: true, passwordHash: await hashPassword(input.password), passwordSetAt: at, mustChange: false, createdAt: at, lastSignInAt: at };
    this.data.users.push(u);
    this.setupCode = null;
    this.save();
    this.log.info('auth', `Created the first administrator, ${u.username}`, { username: u.username, ip });
    return u;
  }

  // ---- sessions ----------------------------------------------------------------------

  startSession(u: User, ip: string, agent: string) {
    const token = crypto.randomBytes(32).toString('base64url');
    const s: Session = { id: newId(), hash: sha256(token), userId: u.id, createdAt: this.now(), lastSeen: this.now(), ip, agent: agent.slice(0, 200) };
    this.sessions.set(s.hash, s);
    this.saveSessions();
    return token;
  }

  endSession(token: string) {
    if (this.sessions.delete(sha256(token))) this.saveSessions();
  }

  revokeSessions(userId: string) {
    let n = 0;
    for (const [h, s] of this.sessions) if (s.userId === userId) this.sessions.delete(h) && n++;
    if (n) this.saveSessions();
    return n;
  }

  revokeSession(id: string) {
    for (const [h, s] of this.sessions) if (s.id === id) this.sessions.delete(h);
    this.saveSessions();
  }

  listSessions() {
    const byId = new Map(this.data.users.map((u) => [u.id, u]));
    this.expireSessions();
    return [...this.sessions.values()]
      .map((s) => ({ id: s.id, user: byId.get(s.userId)?.username ?? '?', ip: s.ip, agent: s.agent, createdAt: new Date(s.createdAt).toISOString(), lastSeen: new Date(s.lastSeen).toISOString() }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  private sessionValid(s: Session) {
    const st = this.data.settings;
    return this.now() - s.lastSeen < st.sessionIdleHours * 3_600_000 && this.now() - s.createdAt < st.sessionMaxDays * DAY_MS;
  }

  private expireSessions() {
    let n = 0;
    for (const [h, s] of this.sessions) if (!this.sessionValid(s)) this.sessions.delete(h) && n++;
    if (n) this.saveSessions();
  }

  // ---- who is calling ----------------------------------------------------------------

  /** The person behind a session cookie or `Authorization: Bearer` token, if any. */
  identify(cookieToken: string | undefined, bearer: string | undefined): Caller | null {
    if (bearer) {
      const t = this.data.tokens.find((x) => x.hash === sha256(bearer));
      if (!t || Date.parse(t.expiresAt) <= this.now()) return null;
      const u = this.data.users.find((x) => x.id === t.userId && x.active);
      if (!u) return null;
      if (!t.lastUsedAt || this.now() - Date.parse(t.lastUsedAt) > 60_000) {
        t.lastUsedAt = new Date(this.now()).toISOString();
        this.save();
      }
      const role: Role = t.scope === 'write' ? (u.role === 'viewer' ? 'viewer' : 'editor') : 'viewer';
      return { user: u, role, via: 'token', tokenId: t.id };
    }
    if (!cookieToken) return null;
    const s = this.sessions.get(sha256(cookieToken));
    if (!s) return null;
    if (!this.sessionValid(s)) {
      this.sessions.delete(s.hash);
      this.saveSessions();
      return null;
    }
    const u = this.data.users.find((x) => x.id === s.userId && x.active);
    if (!u) return null;
    s.lastSeen = this.now();
    this.sessionsDirty = true;
    return { user: u, role: u.role, via: 'session', sessionId: s.id };
  }

  // ---- API tokens --------------------------------------------------------------------

  tokens() {
    const byId = new Map(this.data.users.map((u) => [u.id, u]));
    return this.data.tokens.map(({ hash, ...t }) => ({ ...t, user: byId.get(t.userId)?.username ?? '?', expired: Date.parse(t.expiresAt) <= this.now() }));
  }

  createToken(input: z.infer<typeof schemas.createToken>, by: string) {
    const u = this.user(input.userId);
    if (!u.active) throw new HttpError(400, `${u.username} is inactive`);
    const secret = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
    const t: StoredToken = { id: newId(), name: input.name, userId: u.id, scope: input.scope, prefix: secret.slice(0, 12), hash: sha256(secret), createdAt: new Date(this.now()).toISOString(), createdBy: by, expiresAt: new Date(this.now() + input.expiresInDays * DAY_MS).toISOString(), lastUsedAt: null };
    this.data.tokens.push(t);
    this.save();
    this.log.info('admin', `${by} created API token "${t.name}" for ${u.username} (${t.scope})`, { by, user: u.username, scope: t.scope, expiresAt: t.expiresAt });
    return { token: secret, id: t.id };
  }

  revokeToken(id: string, by: string) {
    const t = this.data.tokens.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'No such token', 'not_found');
    this.data.tokens = this.data.tokens.filter((x) => x.id !== id);
    this.save();
    this.log.info('admin', `${by} revoked API token "${t.name}"`, { by });
  }

  /** For the Checks page. */
  health() {
    const active = this.data.users.filter((u) => u.active);
    return {
      users: active.length,
      admins: this.activeAdmins().length,
      adminsMustChange: active.filter((u) => u.role === 'admin' && u.mustChange).length,
      settings: this.settings,
      sessions: this.sessions.size,
      tokens: this.data.tokens.length,
      tokensExpired: this.data.tokens.filter((t) => Date.parse(t.expiresAt) <= this.now()).length,
      tokensStale: this.data.tokens.filter((t) => Date.parse(t.expiresAt) > this.now() && Date.parse(t.lastUsedAt ?? t.createdAt) < this.now() - 90 * DAY_MS).length,
      setupPending: !!this.setupCode,
    };
  }

  /** Whether the BINDER_PASSWORD from the environment still opens the admin account. */
  async envPasswordStillWorks(envPassword: string | undefined) {
    const admin = this.data.users.find((u) => u.username === 'admin' && u.passwordHash);
    return !!(envPassword && admin && (await verifyPassword(envPassword, admin.passwordHash!)));
  }
}
