import type { NextFunction, Request, Response } from 'express';
import type { Logger } from './log';

// Protection for running on the open internet (adapted from Boards): rate limits per client
// address and per signed-in person, temporary blocks for abusive clients that grow
// exponentially for repeat offenders, a cap on open live-update connections, and a list of
// trusted addresses that are never limited. Everything is in memory and resets on restart.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'invalid_argument',
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** Token bucket: `burst` requests at once, refilling to allow `perMinute` on average. */
export interface Limit {
  burst: number;
  perMinute: number;
}

export interface SecurityOptions {
  /** Every request (pages, pictures, API) per client address. */
  ip: Limit;
  /** API requests from someone not signed in, per address. */
  anonymous: Limit;
  /** API requests per signed-in person (or API token). */
  user: Limit;
  /** Changes (POST/PUT/PATCH/DELETE) per signed-in person. */
  mutations: Limit;
  /** Sign-in attempts per address. */
  signIn: Limit;
  /** Expensive operations (backups, restores, price runs, price-site searches) per person. */
  heavy: Limit;
  /** Every request (cards, pictures, pages) per signed-in guest, instead of the per-address limit. */
  guest: Limit;
  /**
   * Guest sign-in and the guest page's start-up check, per address. Looser than signIn: at a card
   * show many guests share the venue's Wi-Fi or a phone network's address.
   */
  guestSignIn: Limit;
  streamsPerUser: number;
  streamsPerIp: number;
  streamsTotal: number;
  /**
   * Temporary blocks: an address that trips limits this often, fails sign-in this often, or
   * asks for this many missing API paths within the window is blocked. Each further block of
   * the same address within a day lasts twice as long, up to maxDurationMs.
   */
  ban: { violations: number; authFailures: number; notFound: number; windowMs: number; durationMs: number; maxDurationMs: number };
  maxTrackedKeys: number;
  /** Trusted client addresses (exact IPs or IPv4 CIDR ranges) that are never limited or blocked. */
  allowlist: string[];
}

export const DEFAULT_SECURITY: SecurityOptions = {
  ip: { burst: 400, perMinute: 900 },
  anonymous: { burst: 30, perMinute: 60 },
  user: { burst: 200, perMinute: 600 },
  mutations: { burst: 100, perMinute: 240 },
  signIn: { burst: 5, perMinute: 5 },
  heavy: { burst: 10, perMinute: 6 },
  guest: { burst: 300, perMinute: 600 },
  guestSignIn: { burst: 40, perMinute: 60 },
  streamsPerUser: 10,
  streamsPerIp: 20,
  streamsTotal: 200,
  ban: { violations: 60, authFailures: 20, notFound: 120, windowMs: 10 * 60_000, durationMs: 15 * 60_000, maxDurationMs: 24 * 60 * 60_000 },
  maxTrackedKeys: 50_000,
  allowlist: [],
};

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Exact addresses and IPv4 CIDR ranges ("203.0.113.0/24"). */
export function ipMatcher(entries: string[]): (ip: string) => boolean {
  const exact = new Set<string>();
  const ranges: { base: number; mask: number }[] = [];
  for (const raw of entries.map((e) => e.trim()).filter(Boolean)) {
    const [addr, bits] = raw.split('/');
    const base = ipv4ToInt(addr);
    if (bits !== undefined && base !== null && /^\d+$/.test(bits) && Number(bits) <= 32) {
      const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      ranges.push({ base: (base & mask) >>> 0, mask });
    } else exact.add(raw.toLowerCase());
  }
  return (ip: string) => {
    const plain = ip.toLowerCase().replace(/^::ffff:/, '');
    if (exact.has(ip.toLowerCase()) || exact.has(plain)) return true;
    const n = ipv4ToInt(plain);
    return n !== null && ranges.some((r) => ((n & r.mask) >>> 0) === r.base);
  };
}

export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limit: Limit,
    private readonly maxKeys: number,
    private readonly now: () => number,
  ) {}

  /** Spend one token; when empty, how long until one is back. */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const rate = this.limit.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.limit.burst, b.tokens + (now - b.at) * rate);
      b.at = now;
      this.buckets.delete(key);
    } else {
      b = { tokens: this.limit.burst, at: now };
      if (this.buckets.size >= this.maxKeys) this.evict();
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / rate) };
  }

  sweep() {
    const now = this.now();
    const rate = this.limit.perMinute / 60_000;
    for (const [key, b] of this.buckets) if (b.tokens + (now - b.at) * rate >= this.limit.burst) this.buckets.delete(key);
  }

  private evict() {
    this.sweep();
    let excess = this.buckets.size - Math.floor(this.maxKeys * 0.9);
    for (const key of this.buckets.keys()) {
      if (excess-- <= 0) break;
      this.buckets.delete(key);
    }
  }
}

class EventCounter {
  private readonly events = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly now: () => number,
  ) {}
  add(key: string): number {
    const now = this.now();
    const list = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.events.delete(key);
    if (this.events.size >= this.maxKeys) this.events.delete(this.events.keys().next().value!);
    this.events.set(key, list);
    return list.length;
  }
  clear(key: string) {
    this.events.delete(key);
  }
  sweep() {
    const now = this.now();
    for (const [key, list] of this.events) if (!list.some((t) => now - t < this.windowMs)) this.events.delete(key);
  }
}

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Where a 401 means a wrong password. */
const SIGN_IN_PATHS = new Set(['/api/auth/login', '/api/auth/password', '/api/auth/setup']);
const DAY_MS = 86_400_000;

export interface BanInfo {
  ip: string;
  until: string;
  reason: string;
  /** How many times this address has been blocked in the last day. */
  strikes: number;
}

export class Security {
  readonly options: SecurityOptions;
  private readonly buckets: Record<'ip' | 'anonymous' | 'user' | 'mutations' | 'signIn' | 'heavy' | 'guest' | 'guestSignIn', TokenBucket>;
  private readonly violations: EventCounter;
  private readonly authFailures: EventCounter;
  private readonly notFounds: EventCounter;
  private readonly bans = new Map<string, { until: number; reason: string }>();
  /** Recent blocks per address, so repeat offenders are blocked for longer. */
  private readonly strikes = new Map<string, number[]>();
  private readonly streams = new Map<string, number>();
  private streamsOpen = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly trusted: (ip: string) => boolean;
  /** Totals since the server started, for the Security page. */
  readonly stats = { limited: 0, blocked: 0, refused: 0 };

  constructor(
    options: Partial<SecurityOptions> = {},
    private readonly log?: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.options = { ...DEFAULT_SECURITY, ...options, ban: { ...DEFAULT_SECURITY.ban, ...options.ban } };
    const o = this.options;
    const b = (l: Limit) => new TokenBucket(l, o.maxTrackedKeys, now);
    this.buckets = { ip: b(o.ip), anonymous: b(o.anonymous), user: b(o.user), mutations: b(o.mutations), signIn: b(o.signIn), heavy: b(o.heavy), guest: b(o.guest), guestSignIn: b(o.guestSignIn) };
    this.violations = new EventCounter(o.ban.windowMs, o.maxTrackedKeys, now);
    this.authFailures = new EventCounter(o.ban.windowMs, o.maxTrackedKeys, now);
    this.notFounds = new EventCounter(o.ban.windowMs, o.maxTrackedKeys, now);
    this.trusted = ipMatcher(o.allowlist);
  }

  start(everyMs = 60_000) {
    this.timer = setInterval(() => this.sweep(), everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  sweep() {
    for (const b of Object.values(this.buckets)) b.sweep();
    for (const c of [this.violations, this.authFailures, this.notFounds]) c.sweep();
    const now = this.now();
    for (const [ip, ban] of this.bans) if (ban.until <= now) this.bans.delete(ip);
    for (const [ip, list] of this.strikes) {
      const recent = list.filter((t) => now - t < DAY_MS);
      if (recent.length) this.strikes.set(ip, recent);
      else this.strikes.delete(ip);
    }
  }

  isTrusted(ip: string) {
    return this.trusted(ip);
  }

  isBanned(ip: string) {
    const ban = this.bans.get(ip);
    if (!ban) return false;
    if (ban.until <= this.now()) {
      this.bans.delete(ip);
      return false;
    }
    return true;
  }

  /** Block an address. Each block within a day doubles the length: 15 min, 30 min, 1 h … up to a day. */
  ban(ip: string, reason: string) {
    if (this.isBanned(ip) || this.trusted(ip)) return;
    const now = this.now();
    const strikes = [...(this.strikes.get(ip) ?? []).filter((t) => now - t < DAY_MS), now];
    this.strikes.set(ip, strikes);
    const ms = Math.min(this.options.ban.maxDurationMs, this.options.ban.durationMs * 2 ** (strikes.length - 1));
    this.bans.set(ip, { until: now + ms, reason });
    this.stats.blocked++;
    this.log?.warn('security', `Blocked ${ip} for ${Math.round(ms / 60_000)} minutes: ${reason}`, { ip, reason, minutes: Math.round(ms / 60_000), strikes: strikes.length });
  }

  unban(ip: string) {
    const had = this.bans.delete(ip);
    this.strikes.delete(ip);
    if (had) this.log?.info('security', `Unblocked ${ip}`, { ip });
    return had;
  }

  listBans(): BanInfo[] {
    this.sweep();
    return [...this.bans].map(([ip, b]) => ({ ip, until: new Date(b.until).toISOString(), reason: b.reason, strikes: this.strikes.get(ip)?.length ?? 1 }));
  }

  private count(counter: EventCounter, ip: string, threshold: number, reason: string) {
    if (this.trusted(ip)) return;
    if (counter.add(ip) >= threshold) {
      counter.clear(ip);
      this.ban(ip, reason);
    }
  }

  /** Spend from a bucket; over the limit is a 429 (and repeated 429s get the address blocked). */
  check(bucket: keyof Security['buckets'], key: string, ip: string, what = 'requests') {
    if (this.trusted(ip)) return;
    const r = this.buckets[bucket].take(key);
    if (r.ok) return;
    this.stats.limited++;
    this.count(this.violations, ip, this.options.ban.violations, 'repeatedly went over the rate limits');
    const secs = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
    throw new HttpError(429, `Too many ${what}. Try again in ${secs} second${secs === 1 ? '' : 's'}.`, 'rate_limited', secs);
  }

  /** First middleware: refuse blocked addresses, apply the per-address limit, and watch for abuse. */
  firewall = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (this.isBanned(ip)) {
      this.stats.refused++;
      res.setHeader('Connection', 'close');
      return void res.status(403).json({ error: 'Access from your network is temporarily blocked.', code: 'blocked' });
    }
    const p = req.path;
    if (p === '/api/health') return next();
    // A signed-in guest has their own limit, so guests sharing a venue's address don't use up each other's.
    const guest = res.locals.guest as { id: string } | undefined;
    if (guest) this.check('guest', `guest:${guest.id}`, ip);
    else this.check('ip', ip, ip);
    res.on('finish', () => {
      if (res.statusCode === 401 && SIGN_IN_PATHS.has(p)) this.count(this.authFailures, ip, this.options.ban.authFailures, 'too many failed sign-ins');
      else if (res.statusCode === 404 && p.startsWith('/api/')) this.count(this.notFounds, ip, this.options.ban.notFound, 'probing for API paths');
    });
    next();
  };

  /** Per-person (or anonymous) API limits, after sign-in has identified the caller. */
  apiLimits = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const who = res.locals.user as { id: string } | undefined;
    // Guests were limited by the firewall already; their sign-in has its own, looser, per-address limit.
    if (!who && res.locals.guest) return next();
    if (!who && req.path.startsWith('/guest/')) this.check('guestSignIn', ip, ip, 'guest sign-ins from your network');
    else if (!who) this.check('anonymous', ip, ip);
    else {
      this.check('user', who.id, ip);
      if (MUTATING.has(req.method)) this.check('mutations', who.id, ip, 'changes');
    }
    next();
  };

  signIn = (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === 'POST') this.check('signIn', req.ip ?? 'unknown', req.ip ?? 'unknown', 'sign-in attempts');
    next();
  };

  heavy = (req: Request, res: Response, next: NextFunction) => {
    const who = res.locals.user as { id: string } | undefined;
    this.check('heavy', who ? who.id : `ip:${req.ip}`, req.ip ?? 'unknown', 'backup, restore and price operations');
    next();
  };

  /**
   * Reserve a live-update connection; returns a release function, or throws 429. A signed-in
   * guest's (`guestId`) count against that guest instead of their address, like their requests,
   * so guests sharing a venue's Wi-Fi don't use up each other's.
   */
  openStream(req: Request, res: Response, guestId?: string): () => void {
    const ip = req.ip ?? 'unknown';
    const who = guestId ? `guest:${guestId}` : ((res.locals.user as { id: string } | undefined)?.id ?? `ip:${ip}`);
    const o = this.options;
    const perIp = !guestId && (this.streams.get(`ip:${ip}`) ?? 0) >= o.streamsPerIp;
    if (!this.trusted(ip) && (this.streamsOpen >= o.streamsTotal || (this.streams.get(who) ?? 0) >= o.streamsPerUser || perIp)) {
      throw new HttpError(429, 'Too many open live-update connections. Close some tabs and reload.', 'rate_limited', 30);
    }
    const keys = who === `ip:${ip}` || guestId ? [who] : [who, `ip:${ip}`];
    for (const k of keys) this.streams.set(k, (this.streams.get(k) ?? 0) + 1);
    this.streamsOpen++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.streamsOpen--;
      for (const k of keys) {
        const n = (this.streams.get(k) ?? 1) - 1;
        if (n > 0) this.streams.set(k, n);
        else this.streams.delete(k);
      }
    };
  }

  summary() {
    return { stats: { ...this.stats }, streamsOpen: this.streamsOpen, bans: this.listBans(), limits: this.options, allowlist: this.options.allowlist };
  }
}
