import { err, ok, type Result } from '#shared/result.ts';

// What makes a new password acceptable.

/** Very common passwords people reach for first. */
const COMMON = new Set(['password', 'password1', 'password123', '123456789', '1234567890', 'qwertyuiop', 'pokemon', 'pokemon123', 'pikachu', 'pikachu123', 'charizard', 'letmein123', 'iloveyou', 'admin12345', 'changeme', 'welcome123']);

export type WeakPassword = { readonly code: 'PASSWORD_TOO_SHORT'; readonly min: number } | { readonly code: 'PASSWORD_IS_USERNAME' } | { readonly code: 'PASSWORD_TOO_EASY' };

/** A new password for `username`: long enough, not the username, and not one people guess first. */
export function checkNewPassword(password: string, username: string, minLength: number): Result<string, WeakPassword> {
  if (password.length < minLength) return err({ code: 'PASSWORD_TOO_SHORT', min: minLength });
  if (password.toLowerCase() === username.toLowerCase()) return err({ code: 'PASSWORD_IS_USERNAME' });
  if (COMMON.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) return err({ code: 'PASSWORD_TOO_EASY' });
  return ok(password);
}
