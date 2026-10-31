import { err, ok, type Result } from '#shared/result.ts';
import { DOCUMENT_ID, DOCUMENT_ID_RULE } from './ids.ts';
import { isRecord } from './document.ts';

// Small rules for checking a document's fields. Each one checks a value and returns it (a few
// tidy it, like a strict object dropping keys it doesn't know), or the first problem with
// where it is ("prices.0.amount") and what is wrong.

export type Problem = { readonly path: string; readonly message: string };
export type Rule = (value: unknown, path: string) => Result<unknown, Problem>;

const problem = (path: string, message: string) => err({ path, message });
const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

export const text =
  (max: number): Rule =>
  (v, path) => {
    if (typeof v !== 'string') return problem(path, 'Expected text');
    if (v.length > max) return problem(path, `Too long: at most ${max} characters`);
    return ok(v);
  };

/** Also null or missing. */
export const nullish =
  (rule: Rule): Rule =>
  (v, path) =>
    v === null || v === undefined ? ok(v) : rule(v, path);

export const optText = (max: number): Rule => nullish(text(max));

export const bool: Rule = (v, path) => (typeof v === 'boolean' ? ok(v) : problem(path, 'Expected true or false'));

/** A finite number within the bounds given (min inclusive unless `above` is used). */
export const number =
  (o: { min?: number; above?: number; max?: number } = {}): Rule =>
  (v, path) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return problem(path, 'Expected a number');
    if (o.min !== undefined && v < o.min) return problem(path, `Too small: at least ${o.min}`);
    if (o.above !== undefined && v <= o.above) return problem(path, `Too small: more than ${o.above}`);
    if (o.max !== undefined && v > o.max) return problem(path, `Too big: at most ${o.max}`);
    return ok(v);
  };

/** An amount of money in whole cents: at least 0.01 and at most `max`, with no more than 2 decimals. */
export const cents =
  (max: number): Rule =>
  (v, path) => {
    const r = number({ min: 0.01, max })(v, path);
    if (!r.ok) return r;
    return typeof v === 'number' && Math.round(v * 100) / 100 === v ? ok(v) : problem(path, 'Expected an amount in cents: at most 2 decimals');
  };

export const integer =
  (min: number, max: number): Rule =>
  (v, path) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return problem(path, 'Expected a whole number');
    if (v < min) return problem(path, `Too small: at least ${min}`);
    if (v > max) return problem(path, `Too big: at most ${max}`);
    return ok(v);
  };

/** A count of something that starts at 1: a page, a pocket. */
export const count = (max: number): Rule => integer(1, max);

export const oneOf =
  (values: readonly string[]): Rule =>
  (v, path) =>
    typeof v === 'string' && values.includes(v) ? ok(v) : problem(path, `Expected one of ${values.map((x) => JSON.stringify(x)).join(', ')}`);

export const documentIdRule: Rule = (v, path) => (typeof v === 'string' && DOCUMENT_ID.test(v) ? ok(v) : problem(path, DOCUMENT_ID_RULE));

export const arrayOf =
  (rule: Rule, max: number): Rule =>
  (v, path) => {
    if (!Array.isArray(v)) return problem(path, 'Expected a list');
    if (v.length > max) return problem(path, `Too many: at most ${max}`);
    const out: unknown[] = [];
    for (const [i, item] of v.entries()) {
      const r = rule(item, join(path, i));
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  };

export type Shape = Readonly<Record<string, Rule>>;

function checkShape(v: Record<string, unknown>, shape: Shape, path: string, keepOthers: boolean): Result<Record<string, unknown>, Problem> {
  const out: Record<string, unknown> = keepOthers ? { ...v } : {};
  for (const [key, rule] of Object.entries(shape)) {
    const r = rule(v[key], join(path, key));
    if (!r.ok) return key in v ? r : problem(join(path, key), 'Required');
    if (key in v) out[key] = r.value;
  }
  return ok(out);
}

/** Check an object's known fields, keeping the fields the shape doesn't name as they are. */
export const checkLoose = (v: Record<string, unknown>, shape: Shape, path = ''): Result<Record<string, unknown>, Problem> => checkShape(v, shape, path, true);

/** An object whose known fields are checked; fields the shape doesn't name are kept as they are. */
export const loose =
  (shape: Shape): Rule =>
  (v, path) =>
    isRecord(v) ? checkShape(v, shape, path, true) : problem(path, 'Expected an object');

/** An object with only the fields the shape names: any others are dropped. */
export const strict =
  (shape: Shape): Rule =>
  (v, path) =>
    isRecord(v) ? checkShape(v, shape, path, false) : problem(path, 'Expected an object');

/** An object whose keys are some of `keys`, each value checked by `rule`. */
export const someOf =
  (keys: readonly string[], rule: Rule): Rule =>
  (v, path) => {
    if (!isRecord(v)) return problem(path, 'Expected an object');
    for (const [key, value] of Object.entries(v)) {
      if (!keys.includes(key)) return problem(join(path, key), `Expected one of ${keys.map((x) => JSON.stringify(x)).join(', ')}`);
      const r = rule(value, join(path, key));
      if (!r.ok) return r;
    }
    return ok(v);
  };
