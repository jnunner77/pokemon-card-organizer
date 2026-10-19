import { err, ok, type Result } from '#shared/result.ts';
import { expected, isRecord, textProblem } from './input.ts';
import type { InvalidSetting } from './settings.ts';

// PriceCharting's API token: 40 letters and digits, from PriceCharting's Subscription page →
// API/Download. It's kept in a file of its own outside the data that's backed up; nothing shows,
// logs or returns it, only whether one is saved and when.

const TOKEN = /^[A-Za-z0-9]{20,100}$/;
export const NOT_A_TOKEN = "That isn't a PriceCharting API token: copy the 40-character token from PriceCharting's Subscription page (API/Download).";

/** Whether a PriceCharting token is saved, and when it was saved. */
export interface TokenState {
  readonly set: boolean;
  readonly savedAt: string | null;
}

/** The token from what an administrator sent ({ token }), spaces around it dropped. */
export function checkTokenFormat(input: unknown): Result<string, InvalidSetting> {
  if (!isRecord(input)) return err({ code: 'INVALID_SETTING', message: expected('object', input) });
  const token = input['token'];
  const problem = textProblem(token);
  if (problem !== null || typeof token !== 'string') return err({ code: 'INVALID_SETTING', message: problem ?? NOT_A_TOKEN });
  const trimmed = token.trim();
  return TOKEN.test(trimmed) ? ok(trimmed) : err({ code: 'INVALID_SETTING', message: NOT_A_TOKEN });
}
