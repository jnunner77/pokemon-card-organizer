import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';

// One password protects the whole ledger (it's one person's collection). Set it with the
// BINDER_PASSWORD environment variable; without it the app is open, which is only meant for
// running on your own computer. A signed-in browser keeps a cookie for 30 days. The cookie is
// signed with a key kept in the data directory and the password itself, so changing the
// password signs every browser out.

export const SESSION_COOKIE = 'binder_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

/** Paths anyone may load: the sign-in page and what it needs. */
const PUBLIC = [/^\/login\.(html|js)$/, /^\/styles\.css$/, /^\/icon\.svg$/, /^\/fonts\//, /^\/api\/(health|login|session)$/];

export class Auth {
  private readonly key: Buffer | null;
  private readonly password: Buffer | null;
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(
    dataDir: string,
    password = process.env.BINDER_PASSWORD,
    private readonly now: () => number = Date.now,
  ) {
    if (!password) {
      this.key = this.password = null;
      return;
    }
    this.password = Buffer.from(password.normalize('NFKC'));
    const file = path.join(dataDir, 'session.key');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
    }
    this.key = crypto.createHmac('sha256', fs.readFileSync(file)).update(this.password).digest();
  }

  get enabled() {
    return !!this.key;
  }

  private sign(expires: number) {
    return crypto.createHmac('sha256', this.key!).update(String(expires)).digest('base64url');
  }

  private valid(req: Request) {
    const token = readCookie(req, SESSION_COOKIE);
    const [exp, sig] = (token ?? '').split('.');
    const expires = Number(exp);
    if (!sig || !(expires > this.now())) return false;
    const want = Buffer.from(this.sign(expires));
    const got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  private checkPassword(input: string) {
    // Compare digests so the comparison takes the same time whatever the length.
    const a = crypto.createHash('sha256').update(input.normalize('NFKC')).digest();
    const b = crypto.createHash('sha256').update(this.password!).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** Turns away anyone not signed in: pages go to the sign-in page, everything else gets 401. */
  guard = (req: Request, res: Response, next: NextFunction) => {
    if (!this.enabled || PUBLIC.some((p) => p.test(req.path)) || this.valid(req)) return next();
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) return void res.redirect(302, 'login.html');
    res.status(401).json({ error: 'Please sign in', code: 'signin' });
  };

  routes() {
    const r = express.Router();
    r.get('/session', (req, res) => {
      res.json({ required: this.enabled, signedIn: !this.enabled || this.valid(req) });
    });
    r.post('/login', express.json({ limit: '4kb' }), (req, res) => {
      if (!this.enabled) return void res.json({ ok: true });
      const ip = req.ip ?? 'unknown';
      const f = this.failures.get(ip);
      if (f && this.now() - f.since > FAILURE_WINDOW_MS) this.failures.delete(ip);
      if ((this.failures.get(ip)?.count ?? 0) >= MAX_FAILURES) {
        return void res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.', code: 'rate_limited' });
      }
      const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 500) : '';
      if (!this.checkPassword(password)) {
        const cur = this.failures.get(ip) ?? { count: 0, since: this.now() };
        cur.count++;
        this.failures.set(ip, cur);
        return void res.status(401).json({ error: 'That password is wrong.', code: 'signin' });
      }
      this.failures.delete(ip);
      const expires = this.now() + SESSION_DAYS * 86_400_000;
      res.cookie(SESSION_COOKIE, `${expires}.${this.sign(expires)}`, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86_400_000, path: '/' });
      res.json({ ok: true });
    });
    r.post('/logout', (_req, res) => {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(204).end();
    });
    return r;
  }
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
