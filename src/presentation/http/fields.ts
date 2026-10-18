import { err, ok, type Result } from '#shared/result.ts';
import { isRecord } from './parse.ts';

// Reading a JSON object's fields by hand, with messages that name the field. Each check returns
// the value or the message to answer 400 with.

export type Fields = Readonly<Record<string, unknown>>;

/** The body as an object with only these fields. */
export function fieldsOf(body: unknown, allowed: readonly string[]): Result<Fields, string> {
  if (!isRecord(body)) return err('Expected an object');
  const unknown = Object.keys(body).find((k) => !allowed.includes(k));
  return unknown === undefined ? ok(body) : err(`Unrecognized field "${unknown}"`);
}

/** Text; `max` limits its length once spaces around it are dropped. */
export function textField(fields: Fields, key: string, o: { readonly max?: number } = {}): Result<string, string> {
  const v = fields[key];
  if (v === undefined) return err(`${key}: Required`);
  if (typeof v !== 'string') return err(`${key}: Expected text`);
  if (o.max !== undefined && v.trim().length > o.max) return err(`${key}: Too big: at most ${o.max} characters`);
  return ok(v);
}

export function optionalText(fields: Fields, key: string): Result<string | undefined, string> {
  return fields[key] === undefined ? ok(undefined) : textField(fields, key);
}

export function boolField(fields: Fields, key: string, fallback?: boolean): Result<boolean, string> {
  const v = fields[key];
  if (v === undefined && fallback !== undefined) return ok(fallback);
  if (v === undefined) return err(`${key}: Required`);
  return typeof v === 'boolean' ? ok(v) : err(`${key}: Expected true or false`);
}

export function optionalBool(fields: Fields, key: string): Result<boolean | undefined, string> {
  return fields[key] === undefined ? ok(undefined) : boolField(fields, key);
}

/** A number (whether it's whole and within limits is the use case's to check). */
export function numberField(fields: Fields, key: string, fallback?: number): Result<number, string> {
  const v = fields[key];
  if (v === undefined && fallback !== undefined) return ok(fallback);
  if (v === undefined) return err(`${key}: Required`);
  return typeof v === 'number' && Number.isFinite(v) ? ok(v) : err(`${key}: Expected a number`);
}

export function choiceField<T extends string>(fields: Fields, key: string, is: (v: unknown) => v is T, options: readonly T[], fallback?: T): Result<T, string> {
  const v = fields[key];
  if (v === undefined && fallback !== undefined) return ok(fallback);
  if (v === undefined) return err(`${key}: Required`);
  return is(v) ? ok(v) : err(`${key}: Expected one of ${options.join(', ')}`);
}
