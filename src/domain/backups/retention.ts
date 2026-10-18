import { err, ok, type Result } from '#shared/result.ts';
import { isRecord } from '../ledger/document.ts';

// Which daily copies of the ledger are kept: the newest N days, plus the newest copy of each of the
// last W ISO weeks, plus the newest copy of each of the last M months, so the copies thin out with
// age (two weeks of days, two months of weeks, a year of months by default).

export interface Retention {
  readonly daily: number;
  readonly weekly: number;
  readonly monthly: number;
}

export const DEFAULT_RETENTION: Retention = { daily: 14, weekly: 8, monthly: 12 };

const LIMITS: Readonly<Record<keyof Retention, { readonly min: number; readonly max: number }>> = {
  daily: { min: 1, max: 60 },
  weekly: { min: 0, max: 52 },
  monthly: { min: 0, max: 60 },
};

export type InvalidRetention = { readonly code: 'INVALID_RETENTION'; readonly message: string };

const invalid = (message: string) => err<InvalidRetention>({ code: 'INVALID_RETENTION', message });

/** Retention as an administrator sent it: the three counts, whole numbers within their limits, nothing else. */
export function checkRetention(input: unknown): Result<Retention, InvalidRetention> {
  if (!isRecord(input)) return invalid('Expected an object');
  const unknown = Object.keys(input).find((k) => !(k in LIMITS));
  if (unknown !== undefined) return invalid(`Unrecognized field "${unknown}"`);
  const counts: Record<string, number> = {};
  for (const [key, { min, max }] of Object.entries(LIMITS)) {
    const v = input[key];
    if (v === undefined) return invalid(`${key}: Required`);
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return invalid(`${key}: Expected a whole number`);
    if (v < min) return invalid(`${key}: Too small: at least ${min}`);
    if (v > max) return invalid(`${key}: Too big: at most ${max}`);
    counts[key] = v;
  }
  return ok({ daily: counts['daily'] ?? 0, weekly: counts['weekly'] ?? 0, monthly: counts['monthly'] ?? 0 });
}

/** ISO week ("2026-W40") of a YYYY-MM-DD date. */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Which daily copies (by date, YYYY-MM-DD) tiered retention keeps. */
export function retain(days: readonly string[], r: Retention): Set<string> {
  const sorted = [...new Set(days)].sort().reverse();
  const keep = new Set(sorted.slice(0, r.daily));
  const newestPer = (key: (d: string) => string, n: number) => {
    const seen = new Set<string>();
    for (const d of sorted) {
      const k = key(d);
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > n) break;
      keep.add(d);
    }
  };
  newestPer(isoWeek, r.weekly);
  newestPer((d) => d.slice(0, 7), r.monthly);
  return keep;
}
