import { atLeast, type Role } from '#domain/accounts/role.ts';
import { err, ok, type Result } from '#shared/result.ts';

// Who is calling and what they may do. IdentifyCaller (accounts/identify-caller.ts) works out who
// is calling; routes check what they may do here before reading the request. Administrators
// signed in with a session are also exempt from the rate limits and blocks (exemptFromRateLimits).

export type { Role } from '#domain/accounts/role.ts';

export interface Caller {
  /** Username, for the activity log. */
  readonly name: string;
  readonly role: Role;
}

export type AccessError = { readonly code: 'SIGN_IN_REQUIRED' } | { readonly code: 'NOT_ALLOWED'; readonly needs: Role };

/** The caller, if they are signed in with at least this role. Routes check before reading the request. */
export function requireRole(caller: Caller | null, needs: Role): Result<Caller, AccessError> {
  if (!caller) return err({ code: 'SIGN_IN_REQUIRED' });
  return atLeast(caller.role, needs) ? ok(caller) : err({ code: 'NOT_ALLOWED', needs });
}

/** Administrators signed in with a session are never rate limited or blocked (sign-in attempts still are); API tokens never act as administrators. */
export function exemptFromRateLimits(caller: (Caller & { readonly via: 'session' | 'token' }) | null): boolean {
  return caller !== null && caller.via === 'session' && atLeast(caller.role, 'admin');
}
