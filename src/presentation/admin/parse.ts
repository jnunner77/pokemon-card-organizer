import type { LogQuery } from '#application/logging.ts';
import { choiceProblem, numberProblem, textProblem } from '#domain/admin/input.ts';
import { CATEGORIES, isCategory, isLevel, LEVELS } from '#domain/admin/log.ts';
import { err, ok, type Result } from '#shared/result.ts';

// The Logs page's search, read by hand from the query string, with the 400 messages the API has
// always given.

/** A query string value: one text, or a list when the key was repeated. */
const valueOf = (query: URLSearchParams, key: string): string | readonly string[] | undefined => {
  const all = query.getAll(key);
  return all.length === 0 ? undefined : all.length === 1 ? all[0] : all;
};

/** A whole number from a query string (as Number() reads it), or what's wrong with it. */
function queryNumber(value: string | readonly string[] | undefined, o: { readonly min?: number; readonly max?: number } = {}): Result<number | undefined, string> {
  if (value === undefined) return ok(undefined);
  const n = typeof value === 'string' ? Number(value) : NaN;
  const problem = numberProblem(n, { int: true, ...o });
  return problem === null ? ok(n) : err(problem);
}

/** GET /api/admin/logs?level=&cat=&q=&before=&limit= */
export function parseLogQuery(query: URLSearchParams): Result<LogQuery, string> {
  const level = valueOf(query, 'level');
  const cat = valueOf(query, 'cat');
  const text = valueOf(query, 'q');
  if (level !== undefined && !isLevel(level)) return err(choiceProblem(level, LEVELS) ?? 'Invalid option');
  if (cat !== undefined && !isCategory(cat)) return err(choiceProblem(cat, CATEGORIES) ?? 'Invalid option');
  const textIssue = text === undefined ? null : textProblem(typeof text === 'string' ? text : [...text], { max: 200 });
  if (textIssue !== null) return err(textIssue);
  const before = queryNumber(valueOf(query, 'before'));
  if (!before.ok) return before;
  const limit = queryNumber(valueOf(query, 'limit'), { min: 1, max: 1000 });
  if (!limit.ok) return limit;
  return ok({
    ...(level !== undefined ? { level } : {}),
    ...(cat !== undefined ? { cat } : {}),
    ...(typeof text === 'string' ? { text } : {}),
    ...(before.value !== undefined ? { before: before.value } : {}),
    ...(limit.value !== undefined ? { limit: limit.value } : {}),
  });
}
