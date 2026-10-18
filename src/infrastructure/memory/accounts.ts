import type { AccountStore, FailedSignIns, FirstRunSetup, PasswordHasher, SessionStore } from '#application/accounts/ports.ts';
import type { Secrets } from '#application/ports.ts';
import type { AccountBook } from '#domain/accounts/account-book.ts';
import type { FailedAttempts } from '#domain/accounts/lockout.ts';
import type { Session } from '#domain/accounts/session.ts';
import { DEFAULT_SIGN_IN_SETTINGS } from '#domain/accounts/settings.ts';
import type { Result } from '#shared/result.ts';

// Accounts kept in memory. Wrong-password counts and the first-run setup code are only ever kept in
// memory, so the server uses those two as well; the rest are for tests.

export class MemoryAccountStore implements AccountStore {
  #book: AccountBook;

  constructor(book: Partial<AccountBook> = {}) {
    this.#book = { settings: DEFAULT_SIGN_IN_SETTINGS, users: [], tokens: [], ...book };
  }

  async read(): Promise<AccountBook> {
    return { ...this.#book };
  }

  async change<T, E>(work: (draft: AccountBook) => Result<T, E>): Promise<Result<T, E>> {
    const draft = { ...this.#book };
    const result = work(draft);
    if (result.ok) this.#book = draft;
    return result;
  }
}

export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();
  /** How many times the sessions were saved (added or removed, or flushed with changes). */
  saves = 0;
  #dirty = false;

  async list(): Promise<readonly Session[]> {
    return [...this.#sessions.values()];
  }

  async find(hash: string): Promise<Session | undefined> {
    return this.#sessions.get(hash);
  }

  async add(session: Session): Promise<void> {
    this.#sessions.set(session.hash, session);
    this.saves++;
  }

  async touch(hash: string, lastSeen: number): Promise<void> {
    const s = this.#sessions.get(hash);
    if (!s) return;
    this.#sessions.set(hash, { ...s, lastSeen });
    this.#dirty = true;
  }

  async remove(which: (session: Session) => boolean): Promise<number> {
    let n = 0;
    for (const [hash, s] of this.#sessions) if (which(s) && this.#sessions.delete(hash)) n++;
    if (n) this.saves++;
    return n;
  }

  async flush(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    this.saves++;
  }
}

export class MemoryFailedSignIns implements FailedSignIns {
  readonly #records = new Map<string, FailedAttempts>();

  async get(username: string): Promise<FailedAttempts | undefined> {
    return this.#records.get(username);
  }

  async set(username: string, record: FailedAttempts): Promise<void> {
    this.#records.set(username, record);
  }

  async clear(username: string): Promise<void> {
    this.#records.delete(username);
  }
}

export class MemoryFirstRunSetup implements FirstRunSetup {
  #code: string | null = null;

  async code(): Promise<string | null> {
    return this.#code;
  }

  async set(code: string | null): Promise<void> {
    this.#code = code;
  }
}

/** A fast stand-in for scrypt: "plain:" and the password. Counts its checks. */
export class PlainHasher implements PasswordHasher {
  checks = 0;

  async hash(password: string): Promise<string> {
    return `plain:${password}`;
  }

  async verify(password: string, stored: string | null): Promise<boolean> {
    this.checks++;
    return stored !== null && stored === `plain:${password}`;
  }
}

/** Predictable secrets for tests: numbered, with the digest readable. */
export class CountingSecrets implements Secrets {
  #n = 0;

  #next(): string {
    this.#n++;
    return String(this.#n).padStart(4, '0');
  }

  id(): string {
    return `id${this.#next()}`;
  }

  sessionToken(): string {
    return `session${this.#next()}`;
  }

  apiToken(prefix: string): string {
    return `${prefix}token${this.#next()}`;
  }

  setupCode(): string {
    return `SETUP${this.#next()}`;
  }

  guestKey(): string {
    return `key${this.#next()}`;
  }

  digest(secret: string): string {
    return `hash(${secret})`;
  }

  same(given: string, expected: string): boolean {
    return given === expected;
  }
}
