// Checking what an administrator sent, with the messages the API has always answered 400 with
// ("hour: Too big: expected number to be <=23" without the field name, as before).

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a value is, in the messages' words. */
export function kindOf(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : Number.isFinite(value) ? 'number' : 'Infinity';
  return typeof value;
}

export const expected = (what: string, value: unknown): string => `Invalid input: expected ${what}, received ${kindOf(value)}`;

/** Fields an object may not have, or null when it has none of them. */
export function unrecognized(input: Readonly<Record<string, unknown>>, known: readonly string[]): string | null {
  const extra = Object.keys(input).filter((k) => !known.includes(k));
  if (!extra.length) return null;
  return `Unrecognized key${extra.length === 1 ? '' : 's'}: ${extra.map((k) => `"${k}"`).join(', ')}`;
}

/** What's wrong with a number, or null: not a number, not whole (`int`), or outside min..max. */
export function numberProblem(value: unknown, o: { readonly int?: boolean; readonly min?: number; readonly max?: number } = {}): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return expected('number', value);
  if (o.int && !Number.isInteger(value)) return 'Invalid input: expected int, received number';
  if (o.min !== undefined && value < o.min) return `Too small: expected number to be >=${o.min}`;
  if (o.max !== undefined && value > o.max) return `Too big: expected number to be <=${o.max}`;
  return null;
}

/** What's wrong with text, or null: not text, or longer than `max`. */
export function textProblem(value: unknown, o: { readonly max?: number } = {}): string | null {
  if (typeof value !== 'string') return expected('string', value);
  if (o.max !== undefined && value.length > o.max) return `Too big: expected string to have <=${o.max} characters`;
  return null;
}

export const booleanProblem = (value: unknown): string | null => (typeof value === 'boolean' ? null : expected('boolean', value));

/** One of the choices, or what's wrong. */
export function choiceProblem(value: unknown, choices: readonly string[]): string | null {
  return typeof value === 'string' && choices.includes(value) ? null : `Invalid option: expected one of ${choices.map((c) => `"${c}"`).join('|')}`;
}

// A real calendar date (leap years included), a time with seconds and any fraction, in UTC ("Z").
const DATE = '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8])))';
const ISO_DATE_TIME = new RegExp(`^${DATE}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?Z$`);

/** An ISO date and time in UTC, like 2026-10-18T12:00:00.000Z. */
export const isIsoDateTime = (value: string): boolean => ISO_DATE_TIME.test(value);
