import type { SignInSettings } from './settings.ts';

// Wrong passwords lock the username after a few tries, for longer each time (1, 2, 4 … minutes
// by default), up to a day.

export const MAX_LOCK_MS = 86_400_000;

/** One username's wrong passwords. Times are milliseconds since the epoch. */
export interface FailedAttempts {
  /** Wrong passwords since the last lock. */
  readonly count: number;
  /** Locks so far: each doubles the next one. */
  readonly locks: number;
  readonly lockedUntil: number;
}

/** Whole minutes until the username unlocks, or 0 if it isn't locked. */
export function minutesLocked(record: FailedAttempts | undefined, now: Date): number {
  if (!record || record.lockedUntil <= now.getTime()) return 0;
  return Math.ceil((record.lockedUntil - now.getTime()) / 60_000);
}

/** When the username is locked until (ISO), or null when it isn't. */
export const lockedUntil = (record: FailedAttempts | undefined, now: Date): string | null => (record && record.lockedUntil > now.getTime() ? new Date(record.lockedUntil).toISOString() : null);

/** The record after one more wrong password, and how long it now locks the username for, if it does. */
export function afterWrongPassword(record: FailedAttempts | undefined, settings: SignInSettings, now: Date): { readonly record: FailedAttempts; readonly lockedMs: number | null } {
  const count = (record?.count ?? 0) + 1;
  const locks = record?.locks ?? 0;
  if (count < settings.lockoutAfter) return { record: { count, locks, lockedUntil: record?.lockedUntil ?? 0 }, lockedMs: null };
  const lockedMs = Math.min(MAX_LOCK_MS, settings.lockoutMinutes * 60_000 * 2 ** locks);
  return { record: { count: 0, locks: locks + 1, lockedUntil: now.getTime() + lockedMs }, lockedMs };
}
