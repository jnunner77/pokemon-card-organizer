import { err, ok, type Result } from '#shared/result.ts';

// Who is calling and what they may do. Signing in and roles still live in the Express code
// (server/accounts.ts) until the accounts slice moves; it hands the caller to the layered routes.

/** admin: everything; editor: changes the ledger; viewer: looks only. */
export const ROLES = ['viewer', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Caller {
  /** Username, for the activity log. */
  readonly name: string;
  readonly role: Role;
}

export type AccessError = { readonly code: 'SIGN_IN_REQUIRED' } | { readonly code: 'NOT_ALLOWED'; readonly needs: Role };

const rank = (role: Role) => ROLES.indexOf(role);

/** The caller, if they are signed in with at least this role. Routes check before reading the request. */
export function requireRole(caller: Caller | null, needs: Role): Result<Caller, AccessError> {
  if (!caller) return err({ code: 'SIGN_IN_REQUIRED' });
  return rank(caller.role) >= rank(needs) ? ok(caller) : err({ code: 'NOT_ALLOWED', needs });
}
