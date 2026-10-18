import { err, ok, type Result } from '#shared/result.ts';
import type { Contact, ContactKind } from './contact.ts';

// Guests' visits: who is looking now (sessions, in memory only) and the guest log (who signed in,
// when, and how their visit ended), kept with the guest viewing settings.

export const GUEST_IDLE_MS = 15 * 60_000;
/** Visits kept in the guest log; older ones are dropped. */
export const MAX_GUEST_LOG = 2000;
export const MAX_GUEST_AGENT = 200;

/** Signed out, timed out, ended by an administrator, guest viewing turned off, signed in again, the server restarted. */
export type VisitEnd = 'signout' | 'timeout' | 'admin' | 'closed' | 'replaced' | 'restart';

export interface GuestSettings {
  readonly enabled: boolean;
  /** In the QR code's link; signing in needs it. */
  readonly key: string;
  readonly keyCreatedAt: string;
}

export interface GuestVisit {
  readonly id: string;
  readonly name: string;
  readonly contact: string;
  readonly contactKind: ContactKind;
  readonly ip: string;
  readonly agent: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly endedAt: string | null;
  readonly ended: VisitEnd | null;
}

/** A signed-in guest. Times are milliseconds since the epoch. */
export interface GuestSession {
  readonly id: string;
  /** The hash of the cookie's token. */
  readonly hash: string;
  readonly name: string;
  readonly nameKey: string;
  readonly contact: string;
  readonly contactKey: string;
  readonly contactKind: ContactKind;
  readonly ip: string;
  readonly agent: string;
  readonly createdAt: number;
  readonly lastSeen: number;
}

/** The guest viewing settings and the guest log, as saved. The log is never changed in place, only replaced. */
export interface GuestBook {
  settings: GuestSettings;
  log: readonly GuestVisit[];
}

export type GuestTaken = { readonly code: 'GUEST_NAME_TAKEN' } | { readonly code: 'GUEST_CONTACT_TAKEN'; readonly kind: ContactKind };

export const isGuestLive = (session: GuestSession, now: Date): boolean => now.getTime() - session.lastSeen < GUEST_IDLE_MS;

/** When a guest's visit ends if they don't use the page again. */
export const guestExpiry = (session: GuestSession): string => new Date(session.lastSeen + GUEST_IDLE_MS).toISOString();

/**
 * Whether a guest may sign in alongside those looking now: no two share a name or a contact. The
 * same name and contact again is the same guest (another tab or device): their old session, which
 * the new one replaces, is returned.
 */
export function admitGuest(active: readonly GuestSession[], nameKey: string, contact: Contact): Result<GuestSession | null, GuestTaken> {
  const same = active.find((s) => s.nameKey === nameKey && s.contactKey === contact.key);
  if (same) return ok(same);
  if (active.some((s) => s.nameKey === nameKey)) return err({ code: 'GUEST_NAME_TAKEN' });
  if (active.some((s) => s.contactKey === contact.key)) return err({ code: 'GUEST_CONTACT_TAKEN', kind: contact.kind });
  return ok(null);
}

/** Start a visit in the log, newest first, keeping at most MAX_GUEST_LOG. */
export function logVisit(book: GuestBook, visit: GuestVisit): void {
  book.log = [visit, ...book.log].slice(0, MAX_GUEST_LOG);
}

/** Record how a session's visit ended. A visit that timed out ended 15 minutes after its last use. */
export function endVisit(book: GuestBook, session: GuestSession, how: VisitEnd, now: Date): void {
  const endedAt = new Date(how === 'timeout' ? session.lastSeen + GUEST_IDLE_MS : now.getTime()).toISOString();
  book.log = book.log.map((v) => (v.id === session.id && !v.endedAt ? { ...v, endedAt, ended: how, lastSeenAt: new Date(session.lastSeen).toISOString() } : v));
}

/** Sessions don't survive a restart: close the visits that were open. Returns how many. */
export function closeOpenVisits(book: GuestBook, at: Date): number {
  const iso = at.toISOString();
  let closed = 0;
  book.log = book.log.map((v) => {
    if (v.endedAt) return v;
    closed++;
    return { ...v, endedAt: iso, ended: 'restart' };
  });
  return closed;
}

/** Empty the log of everyone but the guests looking now. Returns how many visits were removed. */
export function clearLog(book: GuestBook, liveIds: ReadonlySet<string>): number {
  const before = book.log.length;
  book.log = book.log.filter((v) => liveIds.has(v.id));
  return before - book.log.length;
}
