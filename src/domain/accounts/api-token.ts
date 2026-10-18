import { err, ok, type Result } from '#shared/result.ts';
import { DAY_MS } from './session.ts';
import type { Role } from './role.ts';

// API tokens act as one person, read-only or read & write (never admin), and always expire.

export const TOKEN_PREFIX = 'binder_';
export const TOKEN_SCOPES = ['read', 'write'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const MAX_TOKEN_NAME = 80;
export const TOKEN_DAYS = { min: 1, max: 365, default: 90 } as const;
/** A token's last use is noted at most this often. */
const NOTE_USE_MS = 60_000;
/** Unused this long, a token shows on the Checks page as one to revoke. */
const STALE_MS = 90 * DAY_MS;

export interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly userId: string;
  readonly scope: TokenScope;
  /** The secret's first characters, so people can tell their tokens apart. */
  readonly prefix: string;
  /** The hash of the secret. */
  readonly hash: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
}

export type TokenError = { readonly code: 'TOKEN_NAME_MISSING' } | { readonly code: 'TOKEN_NAME_TOO_LONG' } | { readonly code: 'INVALID_TOKEN_DAYS'; readonly message: string } | { readonly code: 'TOKEN_NOT_FOUND' };

export const isTokenScope = (value: unknown): value is TokenScope => TOKEN_SCOPES.some((s) => s === value);

/** What a request with the token may do: read & write is editing, unless the person only views. */
export const tokenRole = (scope: TokenScope, personRole: Role): Role => (scope === 'write' && personRole !== 'viewer' ? 'editor' : 'viewer');

export const isExpired = (token: ApiToken, now: Date): boolean => Date.parse(token.expiresAt) <= now.getTime();

export const shouldNoteUse = (token: ApiToken, now: Date): boolean => !token.lastUsedAt || now.getTime() - Date.parse(token.lastUsedAt) > NOTE_USE_MS;

/** Not expired, but unused (or never used) for 90 days. */
export const isStale = (token: ApiToken, now: Date): boolean => !isExpired(token, now) && Date.parse(token.lastUsedAt ?? token.createdAt) < now.getTime() - STALE_MS;

export function readTokenName(raw: string): Result<string, TokenError> {
  const name = raw.trim();
  if (!name) return err({ code: 'TOKEN_NAME_MISSING' });
  return name.length > MAX_TOKEN_NAME ? err({ code: 'TOKEN_NAME_TOO_LONG' }) : ok(name);
}

/** When a token made now for `days` expires: whole days from 1 to 365. */
export function tokenExpiry(days: number, now: Date): Result<string, TokenError> {
  if (!Number.isSafeInteger(days)) return err({ code: 'INVALID_TOKEN_DAYS', message: 'expiresInDays: Expected a whole number' });
  if (days < TOKEN_DAYS.min) return err({ code: 'INVALID_TOKEN_DAYS', message: `expiresInDays: Too small: at least ${TOKEN_DAYS.min}` });
  if (days > TOKEN_DAYS.max) return err({ code: 'INVALID_TOKEN_DAYS', message: `expiresInDays: Too big: at most ${TOKEN_DAYS.max}` });
  return ok(new Date(now.getTime() + days * DAY_MS).toISOString());
}
