import type { SignInSettings } from './settings.ts';

// A signed-in browser. Its cookie holds a random token; only the token's hash is kept.

export const DAY_MS = 86_400_000;
/** Kept of a browser's description. */
export const MAX_AGENT = 200;

/** Times are milliseconds since the epoch. */
export interface Session {
  readonly id: string;
  /** The hash of the cookie's token. */
  readonly hash: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly lastSeen: number;
  readonly ip: string;
  readonly agent: string;
}

/** Still within the idle time and the maximum age. */
export function isSessionLive(session: Session, settings: SignInSettings, now: Date): boolean {
  const at = now.getTime();
  return at - session.lastSeen < settings.sessionIdleHours * 3_600_000 && at - session.createdAt < settings.sessionMaxDays * DAY_MS;
}
