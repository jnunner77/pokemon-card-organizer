import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { z } from 'zod';
import type { Logger } from './log';
import type { Doc } from './schema';
import { HttpError } from './security';
import type { Event, Store } from './store';

// Guests: people who scan the QR code at the table and look through the cards listed for sale,
// without an account.
//
// - A guest gives a name and a phone number or email. No two signed-in guests share a name or a
//   contact; giving the same name and contact again picks the guest's session back up (on this
//   device; any other device is signed out).
// - Sessions end after 15 minutes without use. They are kept in memory only: a restart signs
//   guests out, and they sign in again.
// - Guests can only sign in while guest viewing is on, with the QR code's key. A new key makes
//   old printed codes stop working; turning guest viewing off also signs every guest out.
// - Guests see only cards marked Listed for sale, only their details and market value (rounded
//   up to the dollar), never what was paid, sales, notes, owner, binder location or price logs.
// - Settings and the guest log (who signed in, when and how their visit ended) are in
//   <data>/guests.json, which never reaches backups or API responses other than Administration.

export const GUEST_COOKIE = 'binder_guest';
export const GUEST_IDLE_MS = 15 * 60_000;
/** Visits kept in the guest log; older ones are dropped. */
const MAX_LOG = 2000;

const here = path.dirname(fileURLToPath(import.meta.url));

export interface GuestSettings {
  enabled: boolean;
  /** In the QR code's link; sign-in needs it. */
  key: string;
  keyCreatedAt: string;
}

export interface GuestVisit {
  id: string;
  name: string;
  contact: string;
  contactKind: 'email' | 'phone';
  ip: string;
  agent: string;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  /** signed out, timed out, ended by an administrator, guest viewing turned off, signed in again */
  ended: 'signout' | 'timeout' | 'admin' | 'closed' | 'replaced' | 'restart' | null;
}

interface GuestSession {
  id: string;
  hash: string;
  name: string;
  nameKey: string;
  contact: string;
  contactKey: string;
  contactKind: 'email' | 'phone';
  ip: string;
  agent: string;
  createdAt: number;
  lastSeen: number;
}

export interface Guest {
  id: string;
  name: string;
  contact: string;
}

interface GuestFile {
  settings: GuestSettings;
  log: GuestVisit[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const guestSchemas = {
  login: z
    .object({
      key: z.string().trim().max(100),
      name: z.string().trim().min(1, 'Enter your name').max(80, 'Names can be at most 80 characters'),
      contact: z.string().trim().min(1, 'Enter your phone number or email').max(120, 'That is too long for a phone number or email'),
    })
    .strict(),
  settings: z.object({ enabled: z.boolean() }).strict(),
};

/** "  Ash   KETCHUM " → "ash ketchum": how names are compared. */
export const nameKey = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** An email (lower case) or a phone number (its digits; a North American leading 1 dropped), or why it isn't one. */
export function parseContact(raw: string): { kind: 'email' | 'phone'; key: string; display: string } {
  const s = raw.normalize('NFKC').trim();
  if (s.includes('@')) {
    if (!EMAIL.test(s)) throw new HttpError(400, "That email doesn't look right.");
    return { kind: 'email', key: s.toLowerCase(), display: s };
  }
  if (!/^[+\d\s().-]+$/.test(s)) throw new HttpError(400, 'Enter a phone number or an email.');
  let digits = s.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length < 7 || digits.length > 15) throw new HttpError(400, "That phone number doesn't look right.");
  return { kind: 'phone', key: digits, display: s.replace(/\s+/g, ' ') };
}

// ---- what guests see ------------------------------------------------------------------

/** The card details guests see, as stored. */
const DETAIL_FIELDS = ['name', 'set', 'setCode', 'number', 'rarity', 'variant', 'language', 'condition', 'grader', 'grade', 'artist', 'released'] as const;

export interface GuestCard {
  id: string;
  name: string | null;
  set: string | null;
  setCode: string | null;
  number: string | null;
  rarity: string | null;
  variant: string | null;
  language: string | null;
  condition: string | null;
  grader: string | null;
  grade: string | null;
  artist: string | null;
  released: string | null;
  /** Market value in CAD, rounded up to the dollar. */
  value: number | null;
  /** The picture's address, or null without one. Changes when the picture does. */
  image: string | null;
}

// The page's condition adjustment (public/condition.js), so guests see the value the ledger shows.
type Condition = { adjust: (card: Doc, price: Doc) => number | null };
let condition: Condition | null = null;
function conditionRules(): Condition {
  if (!condition) {
    const sandbox = { window: {} as { BinderCondition?: Condition } };
    vm.runInNewContext(fs.readFileSync(path.join(here, '../public/condition.js'), 'utf8'), sandbox);
    condition = sandbox.window.BinderCondition!;
  }
  return condition;
}

/** A card's market value in CAD as the page works it out (latest market price or sold comp, condition-adjusted), rounded up to the dollar. */
export function guestValue(card: Doc, usdToCad: number): number | null {
  const prices = (Array.isArray(card.prices) ? (card.prices as Doc[]) : [])
    .filter((p) => (p.type === 'market' || p.type === 'comp') && typeof p.amount === 'number')
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || String(b.at ?? '').localeCompare(String(a.at ?? '')));
  const p = prices[0];
  if (!p) return null;
  const amount = conditionRules().adjust(card, p);
  if (amount == null) return null;
  const cad = p.currency === 'USD' ? amount * (usdToCad || 1) : amount;
  // To the cent first, so 21.000000001 stays $21.
  return Math.ceil(Math.round(cad * 100) / 100);
}

/** The picture the ledger shows for a card: the official one unless the person picked their own photo. */
export function shownImage(card: Doc): string | null {
  const official = typeof card.officialImageId === 'string' && card.officialImageId ? card.officialImageId : null;
  const photo = typeof card.imageId === 'string' && card.imageId ? card.imageId : null;
  return official && (card.imagePref !== 'photo' || !photo) ? official : photo;
}

export const isListed = (card: Doc) => card.status === 'listed' && !card.placeholder;

export function guestCard(card: Doc, usdToCad: number): GuestCard {
  const out: Record<string, unknown> = { id: card.id };
  for (const f of DETAIL_FIELDS) out[f] = typeof card[f] === 'string' && card[f] ? card[f] : null;
  out.value = guestValue(card, usdToCad);
  const img = shownImage(card);
  out.image = img ? `api/guest/cards/${encodeURIComponent(String(card.id))}/image?v=${crypto.createHash('sha256').update(img).digest('hex').slice(0, 12)}` : null;
  return out as unknown as GuestCard;
}

/**
 * Live updates for the guest page: what guests see of the cards (the list `GET /api/guest/cards`
 * returns), as JSON, each time it changes. One feed serves every open guest page: card and
 * settings changes are gathered for `delayMs`, the list is worked out once, and it's sent only if
 * it differs from the last one, so ledger changes guests can't see send nothing.
 */
export class GuestFeed {
  private readonly listeners = new Set<(json: string) => void>();
  private last = '';
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: Pick<Store, 'all' | 'subscribe'>,
    private readonly usdToCad: () => number,
    private readonly delayMs = 250,
  ) {}

  cards(): GuestCard[] {
    const rate = this.usdToCad();
    return this.store.all().cards.filter(isListed).map((c) => guestCard(c, rate));
  }

  /** The list as last sent (or now, with nobody listening yet). */
  current(): string {
    return this.listeners.size ? this.last : JSON.stringify(this.cards());
  }

  /** Call `fn` with the list each time it changes; returns the function that stops it. */
  subscribe(fn: (json: string) => void): () => void {
    if (!this.listeners.size) {
      this.last = JSON.stringify(this.cards());
      this.unsubscribe = this.store.subscribe((e) => this.changed(e));
    }
    this.listeners.add(fn);
    return () => {
      if (!this.listeners.delete(fn) || this.listeners.size) return;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  private changed(e: Event) {
    if (e.type === 'change' && e.change.collection === 'binders') return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const json = JSON.stringify(this.cards());
      if (json === this.last) return;
      this.last = json;
      for (const fn of [...this.listeners]) fn(json);
    }, this.delayMs);
  }
}

// ---- sessions and settings ------------------------------------------------------------

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');
const newKey = () => crypto.randomBytes(16).toString('base64url');

export class Guests {
  private data: GuestFile;
  private readonly file: string;
  private readonly sessions = new Map<string, GuestSession>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    dataDir: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'guests.json');
    const at = new Date(this.now()).toISOString();
    this.data = { settings: { enabled: false, key: newKey(), keyCreatedAt: at }, log: [] };
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<GuestFile>;
      this.data = { settings: { ...this.data.settings, ...raw.settings }, log: raw.log ?? [] };
      // Sessions don't survive a restart; close the visits that were open.
      const open = this.data.log.filter((v) => !v.endedAt);
      for (const v of open) Object.assign(v, { endedAt: at, ended: 'restart' });
      if (open.length) this.save();
    } else this.save();
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  start(everyMs = 60_000) {
    this.timer = setInterval(() => this.sweep(), everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  get settings(): GuestSettings {
    return { ...this.data.settings };
  }

  setEnabled(enabled: boolean, by: string) {
    if (this.data.settings.enabled === enabled) return this.settings;
    this.data.settings.enabled = enabled;
    if (!enabled) this.endAll('closed');
    this.save();
    this.log.info('admin', `${by} turned guest viewing ${enabled ? 'on' : 'off'}`, { by });
    return this.settings;
  }

  /** A new key for the QR code: codes printed before stop working. Signed-in guests stay. */
  newKey(by: string) {
    this.data.settings.key = newKey();
    this.data.settings.keyCreatedAt = new Date(this.now()).toISOString();
    this.save();
    this.log.info('admin', `${by} made a new guest QR code; older ones no longer work`, { by });
    return this.settings;
  }

  keyMatches(key: string) {
    const a = Buffer.from(sha256(key));
    const b = Buffer.from(sha256(this.data.settings.key));
    return crypto.timingSafeEqual(a, b);
  }

  private visit(id: string) {
    return this.data.log.find((v) => v.id === id);
  }

  private end(s: GuestSession, how: NonNullable<GuestVisit['ended']>) {
    this.sessions.delete(s.hash);
    const v = this.visit(s.id);
    if (v && !v.endedAt) Object.assign(v, { endedAt: new Date(how === 'timeout' ? s.lastSeen + GUEST_IDLE_MS : this.now()).toISOString(), ended: how, lastSeenAt: new Date(s.lastSeen).toISOString() });
  }

  private endAll(how: NonNullable<GuestVisit['ended']>) {
    for (const s of [...this.sessions.values()]) this.end(s, how);
  }

  private valid(s: GuestSession) {
    return this.now() - s.lastSeen < GUEST_IDLE_MS;
  }

  /** End sessions unused for 15 minutes. */
  sweep() {
    const idle = [...this.sessions.values()].filter((s) => !this.valid(s));
    for (const s of idle) this.end(s, 'timeout');
    if (idle.length) this.save();
  }

  /** Sign a guest in: returns the session token for the cookie. */
  login(input: z.infer<typeof guestSchemas.login>, ip: string, agent: string): { token: string; guest: Guest } {
    if (!this.data.settings.enabled) throw new HttpError(403, 'Guest viewing is closed right now.', 'guests_closed');
    if (!input.key || !this.keyMatches(input.key)) throw new HttpError(403, 'This QR code no longer works. Scan the one at the table.', 'guest_key');
    this.sweep();
    const name = input.name.replace(/\s+/g, ' ');
    const nk = nameKey(name);
    const contact = parseContact(input.contact);
    const active = [...this.sessions.values()];
    const same = active.find((s) => s.nameKey === nk && s.contactKey === contact.key);
    if (!same) {
      if (active.some((s) => s.nameKey === nk)) throw new HttpError(409, 'Someone with that name is already looking. Add your last name or initial.', 'guest_taken');
      if (active.some((s) => s.contactKey === contact.key)) throw new HttpError(409, `Someone else is already looking with that ${contact.kind === 'email' ? 'email' : 'phone number'}.`, 'guest_taken');
    }
    // The same guest again (another tab or device, or after closing the page): carry on as them.
    if (same) this.end(same, 'replaced');
    const token = crypto.randomBytes(32).toString('base64url');
    const at = this.now();
    const s: GuestSession = { id: newId(), hash: sha256(token), name, nameKey: nk, contact: contact.display, contactKey: contact.key, contactKind: contact.kind, ip, agent: agent.slice(0, 200), createdAt: at, lastSeen: at };
    this.sessions.set(s.hash, s);
    const iso = new Date(at).toISOString();
    this.data.log.unshift({ id: s.id, name, contact: s.contact, contactKind: s.contactKind, ip, agent: s.agent, startedAt: iso, lastSeenAt: iso, endedAt: null, ended: null });
    if (this.data.log.length > MAX_LOG) this.data.log.length = MAX_LOG;
    this.save();
    this.log.info('auth', `Guest ${name} signed in`, { guest: name, ip, again: !!same });
    return { token, guest: { id: s.id, name, contact: s.contact } };
  }

  /** The guest behind a cookie. `touch` (the default) counts the request as use. */
  identify(token: string | undefined, touch = true): (Guest & { expiresAt: string }) | null {
    if (!token) return null;
    const s = this.sessions.get(sha256(token));
    if (!s) return null;
    if (!this.valid(s)) {
      this.end(s, 'timeout');
      this.save();
      return null;
    }
    if (touch) s.lastSeen = this.now();
    return { id: s.id, name: s.name, contact: s.contact, expiresAt: new Date(s.lastSeen + GUEST_IDLE_MS).toISOString() };
  }

  logout(token: string) {
    const s = this.sessions.get(sha256(token));
    if (!s) return;
    this.end(s, 'signout');
    this.save();
  }

  endSession(id: string, by: string) {
    const s = [...this.sessions.values()].find((x) => x.id === id);
    if (!s) throw new HttpError(404, 'That guest is no longer signed in', 'not_found');
    this.end(s, 'admin');
    this.save();
    this.log.info('admin', `${by} signed out the guest ${s.name}`, { by, guest: s.name });
  }

  active() {
    this.sweep();
    return [...this.sessions.values()]
      .map((s) => ({ id: s.id, name: s.name, contact: s.contact, contactKind: s.contactKind, ip: s.ip, agent: s.agent, startedAt: new Date(s.createdAt).toISOString(), lastSeenAt: new Date(s.lastSeen).toISOString(), expiresAt: new Date(s.lastSeen + GUEST_IDLE_MS).toISOString() }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /** The guest log, newest first, with signed-in guests' last use filled in. */
  visits(): GuestVisit[] {
    const live = new Map([...this.sessions.values()].map((s) => [s.id, s]));
    return this.data.log.map((v) => {
      const s = live.get(v.id);
      return s ? { ...v, lastSeenAt: new Date(s.lastSeen).toISOString() } : { ...v };
    });
  }

  clearLog(by: string) {
    const live = new Set([...this.sessions.values()].map((s) => s.id));
    const n = this.data.log.filter((v) => !live.has(v.id)).length;
    this.data.log = this.data.log.filter((v) => live.has(v.id));
    this.save();
    this.log.info('admin', `${by} cleared the guest log (${n} visit${n === 1 ? '' : 's'})`, { by, removed: n });
    return n;
  }
}
