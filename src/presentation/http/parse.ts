// Small hand-written checks that turn untrusted JSON into typed input, one field at a time.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A whole number from min to max. */
export const isCount = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

export const isText = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;

/** Each item read by `read`, or null if the value isn't a list of at most `max` (and at least `min`) good items. */
export function listOf<T>(value: unknown, read: (item: unknown) => T | null, limits: { readonly min?: number; readonly max: number }): T[] | null {
  if (!Array.isArray(value) || value.length > limits.max || value.length < (limits.min ?? 0)) return null;
  const out: T[] = [];
  for (const item of value) {
    const r = read(item);
    if (r === null) return null;
    out.push(r);
  }
  return out;
}
