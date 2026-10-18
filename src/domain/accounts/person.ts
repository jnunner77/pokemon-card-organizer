import { err, ok, type Result } from '#shared/result.ts';
import type { Role } from './role.ts';

// A person who can use the ledger. Only the password's hash is kept, never the password.

export interface Person {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly role: Role;
  readonly active: boolean;
  readonly passwordHash: string | null;
  readonly passwordSetAt: string | null;
  /** Their password was set by an administrator: they choose their own before signing in. */
  readonly mustChange: boolean;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
}

/** 2–32 letters, digits, dots, dashes or underscores, compared in lower case. */
const USERNAME = /^[a-z0-9._-]{2,32}$/;
export const MAX_NAME = 80;
const MAX_PASSWORD = 200;

export type PersonError =
  | { readonly code: 'INVALID_USERNAME' }
  | { readonly code: 'NAME_MISSING' }
  | { readonly code: 'NAME_TOO_LONG' }
  | { readonly code: 'PASSWORD_TOO_LONG' }
  | { readonly code: 'USERNAME_TAKEN'; readonly username: string }
  | { readonly code: 'PERSON_NOT_FOUND' }
  | { readonly code: 'PERSON_INACTIVE'; readonly username: string };

/** A username as people type it: spaces around it dropped, compared in lower case. */
export const usernameKey = (raw: string): string => raw.trim().toLowerCase();

export function readUsername(raw: string): Result<string, PersonError> {
  const username = usernameKey(raw);
  return USERNAME.test(username) ? ok(username) : err({ code: 'INVALID_USERNAME' });
}

export function readName(raw: string): Result<string, PersonError> {
  const name = raw.trim();
  if (!name) return err({ code: 'NAME_MISSING' });
  return name.length > MAX_NAME ? err({ code: 'NAME_TOO_LONG' }) : ok(name);
}

/** Passwords are checked for length before anything else, so a huge one is never hashed. */
export function readPassword(raw: string): Result<string, PersonError> {
  return raw.length > MAX_PASSWORD ? err({ code: 'PASSWORD_TOO_LONG' }) : ok(raw);
}
