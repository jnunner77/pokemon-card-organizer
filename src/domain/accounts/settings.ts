import { err, ok, type Result } from '#shared/result.ts';

// How signing in works on this server; administrators change it under Administration → People.

export interface SignInSettings {
  /** Sign out after this long without using the ledger. */
  readonly sessionIdleHours: number;
  /** Sign out after this long regardless. */
  readonly sessionMaxDays: number;
  readonly passwordMinLength: number;
  /** Wrong passwords in a row before the username is locked. */
  readonly lockoutAfter: number;
  /** First lock length; each further lock doubles it, up to a day. */
  readonly lockoutMinutes: number;
}

export const DEFAULT_SIGN_IN_SETTINGS: SignInSettings = { sessionIdleHours: 24 * 14, sessionMaxDays: 30, passwordMinLength: 10, lockoutAfter: 5, lockoutMinutes: 1 };

const SETTING_LIMITS: Readonly<Record<keyof SignInSettings, { readonly min: number; readonly max: number }>> = {
  sessionIdleHours: { min: 1, max: 24 * 90 },
  sessionMaxDays: { min: 1, max: 365 },
  passwordMinLength: { min: 8, max: 64 },
  lockoutAfter: { min: 3, max: 20 },
  lockoutMinutes: { min: 1, max: 60 },
};

export const SETTING_NAMES: readonly (keyof SignInSettings)[] = ['sessionIdleHours', 'sessionMaxDays', 'passwordMinLength', 'lockoutAfter', 'lockoutMinutes'];

export type InvalidSetting = { readonly code: 'INVALID_SETTING'; readonly message: string };

/** The settings with some of them changed: each a whole number within its limits. */
export function changeSettings(current: SignInSettings, change: Partial<Record<keyof SignInSettings, number>>): Result<SignInSettings, InvalidSetting> {
  const next: Record<string, number> = { ...current };
  for (const key of SETTING_NAMES) {
    const v = change[key];
    if (v === undefined) continue;
    const { min, max } = SETTING_LIMITS[key];
    if (!Number.isSafeInteger(v)) return err({ code: 'INVALID_SETTING', message: `${key}: Expected a whole number` });
    if (v < min) return err({ code: 'INVALID_SETTING', message: `${key}: Too small: at least ${min}` });
    if (v > max) return err({ code: 'INVALID_SETTING', message: `${key}: Too big: at most ${max}` });
    next[key] = v;
  }
  return ok({ sessionIdleHours: next['sessionIdleHours'] ?? current.sessionIdleHours, sessionMaxDays: next['sessionMaxDays'] ?? current.sessionMaxDays, passwordMinLength: next['passwordMinLength'] ?? current.passwordMinLength, lockoutAfter: next['lockoutAfter'] ?? current.lockoutAfter, lockoutMinutes: next['lockoutMinutes'] ?? current.lockoutMinutes });
}
