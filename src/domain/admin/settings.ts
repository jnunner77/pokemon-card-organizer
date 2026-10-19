import { err, ok, type Result } from '#shared/result.ts';
import { DEFAULT_RETENTION, type Retention } from '../backups/retention.ts';
import { booleanProblem, choiceProblem, expected, isRecord, numberProblem, unrecognized } from './input.ts';

// Settings only administrators change, kept outside the ledger so restoring a backup of it never
// changes how the server itself is run: backup retention, the daily price update's schedule, how
// a card's daily price is worked out, and when a full backup was last downloaded and the problems
// last marked as seen.

export interface PricingSchedule {
  readonly enabled: boolean;
  /** Hour of the day (0-23) after which the daily price update runs. */
  readonly hour: number;
  /** Whether Cardmarket's price (in euros, from TCGdex) is compared with the others. */
  readonly cardmarket?: boolean;
}

export const PRICE_METHODS = ['blend', 'highest', 'pricecharting'] as const;
export type PriceMethodName = (typeof PRICE_METHODS)[number];
const SOURCES = ['pricecharting', 'tcgplayer', 'cardmarket'] as const;

/** How a card's daily price is worked out from its sources (public/blend.js). */
export interface PriceMethod {
  readonly method: PriceMethodName;
  readonly weights: { readonly pricecharting: number; readonly tcgplayer: number; readonly cardmarket: number };
  /** Percent from PriceCharting's price beyond which a source is left out. */
  readonly tolerance: number;
}

export interface AdminSettings {
  readonly backups: Retention;
  readonly pricing: PricingSchedule;
  /** How a card's daily price is worked out; the default (blend 40/40/20, 25%) when not set. */
  readonly priceMethod?: PriceMethod | null;
  /** When someone last downloaded a full backup (a copy that leaves the server). */
  readonly lastFullBackupAt: string | null;
  /** When an administrator last marked the problems (warnings and errors) as seen. */
  readonly problemsSeenAt?: string | null;
}

export const DEFAULT_ADMIN_SETTINGS: AdminSettings = { backups: DEFAULT_RETENTION, pricing: { enabled: true, hour: 5, cardmarket: true }, lastFullBackupAt: null };

export type InvalidSetting = { readonly code: 'INVALID_SETTING'; readonly message: string };

const invalid = (message: string) => err<InvalidSetting>({ code: 'INVALID_SETTING', message });

/** The first problem among these checks, in order, or null. */
const first = (...problems: readonly (() => string | null)[]): string | null => {
  for (const p of problems) {
    const found = p();
    if (found !== null) return found;
  }
  return null;
};

/** The daily price update's schedule as an administrator sent it. */
export function checkPricingSchedule(input: unknown): Result<PricingSchedule, InvalidSetting> {
  if (!isRecord(input)) return invalid(expected('object', input));
  const { enabled, hour, cardmarket } = input;
  const problem = first(
    () => booleanProblem(enabled),
    () => numberProblem(hour, { int: true, min: 0, max: 23 }),
    () => (cardmarket === undefined ? null : booleanProblem(cardmarket)),
    () => unrecognized(input, ['enabled', 'hour', 'cardmarket']),
  );
  if (problem !== null || typeof enabled !== 'boolean' || typeof hour !== 'number') return invalid(problem ?? 'Invalid input');
  return ok({ enabled, hour, ...(typeof cardmarket === 'boolean' ? { cardmarket } : {}) });
}

/** A price method as an administrator sent it: weights 0-100 (at least one above 0), tolerance 1-1000%. */
export function checkPriceMethod(input: unknown): Result<PriceMethod, InvalidSetting> {
  if (!isRecord(input)) return invalid(expected('object', input));
  const { method, weights, tolerance } = input;
  const weightsProblem = (): string | null => {
    if (!isRecord(weights)) return expected('object', weights);
    return first(...SOURCES.map((s) => () => numberProblem(weights[s], { min: 0, max: 100 })), () => unrecognized(weights, SOURCES));
  };
  const problem = first(
    () => choiceProblem(method, PRICE_METHODS),
    weightsProblem,
    () => numberProblem(tolerance, { min: 1, max: 1000 }),
    () => unrecognized(input, ['method', 'weights', 'tolerance']),
  );
  if (problem !== null) return invalid(problem);
  const name = PRICE_METHODS.find((m) => m === method);
  const w = isRecord(weights) ? { pricecharting: weights['pricecharting'], tcgplayer: weights['tcgplayer'], cardmarket: weights['cardmarket'] } : null;
  if (!name || !w || typeof w.pricecharting !== 'number' || typeof w.tcgplayer !== 'number' || typeof w.cardmarket !== 'number' || typeof tolerance !== 'number') return invalid('Invalid input');
  if (w.pricecharting + w.tcgplayer + w.cardmarket <= 0) return invalid('Give at least one source a weight.');
  return ok({ method: name, weights: { pricecharting: w.pricecharting, tcgplayer: w.tcgplayer, cardmarket: w.cardmarket }, tolerance });
}

export const DEFAULT_PRICE_METHOD: PriceMethod = { method: 'blend', weights: { pricecharting: 40, tcgplayer: 40, cardmarket: 20 }, tolerance: 25 };

/**
 * A saved price method with the default in place of each field that's missing or wrong (the same
 * rules as public/blend.js settings()), so a hand-edited admin.json keeps what it got right.
 */
export function priceMethodFrom(saved: unknown): PriceMethod {
  const o = isRecord(saved) ? saved : {};
  const w = isRecord(o['weights']) ? o['weights'] : {};
  const weight = (source: (typeof SOURCES)[number]): number => {
    const n = Number(Object.hasOwn(w, source) ? w[source] : DEFAULT_PRICE_METHOD.weights[source]);
    return n >= 0 ? n : DEFAULT_PRICE_METHOD.weights[source];
  };
  const t = Number(o['tolerance']);
  return {
    method: PRICE_METHODS.find((m) => m === o['method']) ?? DEFAULT_PRICE_METHOD.method,
    weights: { pricecharting: weight('pricecharting'), tcgplayer: weight('tcgplayer'), cardmarket: weight('cardmarket') },
    tolerance: t > 0 && t <= 1000 ? t : DEFAULT_PRICE_METHOD.tolerance,
  };
}

const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const timeOr = <T extends string | null | undefined>(value: unknown, fallback: T): string | null | T => (typeof value === 'string' || value === null ? value : fallback);

/**
 * The settings as saved (in admin.json), over the defaults: what's missing or the wrong kind of
 * value is the default. "Use PriceCharting" (from when its pages refused the binder) is gone: its
 * API token decides now.
 */
export function adminSettingsFrom(saved: Readonly<Record<string, unknown>> | null, base: AdminSettings): AdminSettings {
  const backups = isRecord(saved?.['backups']) ? saved['backups'] : {};
  const pricing = isRecord(saved?.['pricing']) ? saved['pricing'] : {};
  const cardmarket = typeof pricing['cardmarket'] === 'boolean' ? pricing['cardmarket'] : base.pricing.cardmarket;
  const method = saved?.['priceMethod'];
  const priceMethod = method === undefined ? base.priceMethod : method === null ? null : priceMethodFrom(method);
  const seen = timeOr(saved?.['problemsSeenAt'], base.problemsSeenAt);
  return {
    backups: { daily: numberOr(backups['daily'], base.backups.daily), weekly: numberOr(backups['weekly'], base.backups.weekly), monthly: numberOr(backups['monthly'], base.backups.monthly) },
    pricing: {
      enabled: typeof pricing['enabled'] === 'boolean' ? pricing['enabled'] : base.pricing.enabled,
      hour: numberOr(pricing['hour'], base.pricing.hour),
      ...(cardmarket === undefined ? {} : { cardmarket }),
    },
    ...(priceMethod === undefined ? {} : { priceMethod }),
    lastFullBackupAt: timeOr(saved?.['lastFullBackupAt'], base.lastFullBackupAt),
    ...(seen === undefined ? {} : { problemsSeenAt: seen }),
  };
}
