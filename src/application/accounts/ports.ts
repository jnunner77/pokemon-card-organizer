import type { AccountBook } from '#domain/accounts/account-book.ts';
import type { FailedAttempts } from '#domain/accounts/lockout.ts';
import type { Session } from '#domain/accounts/session.ts';
import type { Result } from '#shared/result.ts';

/** People, their API tokens and the sign-in settings (auth.json). */
export interface AccountStore {
  /** A copy of everything as it is now. */
  read(): Promise<AccountBook>;
  /** Run `work` on a draft: saved when it returns ok, discarded when it returns an error. */
  change<T, E>(work: (draft: AccountBook) => Result<T, E>): Promise<Result<T, E>>;
}

/** Signed-in browsers (sessions.json), so signing in survives restarts. */
export interface SessionStore {
  list(): Promise<readonly Session[]>;
  find(hash: string): Promise<Session | undefined>;
  /** Saved straight away. */
  add(session: Session): Promise<void>;
  /** Note a session was used now; saved with the next flush. */
  touch(hash: string, lastSeen: number): Promise<void>;
  /** End the sessions that match, saved straight away; returns how many. */
  remove(which: (session: Session) => boolean): Promise<number>;
  /** Save last-seen times noted since the last save. */
  flush(): Promise<void>;
}

/** Wrong passwords per username, kept in memory only. */
export interface FailedSignIns {
  get(username: string): Promise<FailedAttempts | undefined>;
  set(username: string, record: FailedAttempts): Promise<void>;
  clear(username: string): Promise<void>;
}

/** The one-time code for creating the first administrator, while there is nobody yet (memory only). */
export interface FirstRunSetup {
  code(): Promise<string | null>;
  set(code: string | null): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /**
   * Whether the password matches the stored hash. Without a hash it checks against a made-up one
   * and answers false, so a missing username takes as long as a wrong password.
   */
  verify(password: string, stored: string | null): Promise<boolean>;
}
