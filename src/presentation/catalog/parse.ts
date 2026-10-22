import { isRecord } from '../http/parse.ts';

// The card lookup and master set routes' input, read by hand from the query string and body.

/** One value of a query string key, trimmed, at most `max` characters (at least `min`); undefined when absent, null when it isn't one good value. */
function queryText(query: URLSearchParams, key: string, min: number, max: number): string | null | undefined {
  const all = query.getAll(key);
  if (!all.length) return undefined;
  const [only] = all;
  if (all.length > 1 || only === undefined) return null;
  const v = only.trim();
  return v.length >= min && v.length <= max ? v : null;
}

/** GET /api/cards/lookup?name=&number=&set=&setCode= */
export function lookupQuery(query: URLSearchParams): { name: string; number: string; set?: string; setCode?: string } | null {
  const name = queryText(query, 'name', 1, 200);
  const number = queryText(query, 'number', 1, 40);
  const set = queryText(query, 'set', 0, 200);
  const setCode = queryText(query, 'setCode', 0, 40);
  if (!name || !number || set === null || setCode === null) return null;
  return { name, number, ...(set !== undefined ? { set } : {}), ...(setCode !== undefined ? { setCode } : {}) };
}

/** GET /api/lookup/search?q= */
export const searchQuery = (query: URLSearchParams): string | null => queryText(query, 'q', 1, 120) ?? null;

/** GET /api/master-sets/preview?set= */
export const setQuery = (query: URLSearchParams): string | null => queryText(query, 'set', 1, 80) ?? null;

const POCKETS: readonly number[] = [4, 9, 12, 16];

export interface MasterSetBody {
  readonly set: string;
  readonly owner: string;
  readonly name: string;
  readonly color: string | null;
  readonly pockets: number;
  readonly extras: boolean;
}

/** POST /api/master-sets: the set, its owner, the binder's name and colour, pockets per page, and whether promo printings come too. */
export function masterSetBody(body: unknown): MasterSetBody | null {
  if (!isRecord(body)) return null;
  const { set, owner, name, color, pockets, extras } = body;
  if (typeof set !== 'string' || typeof owner !== 'string' || typeof name !== 'string') return null;
  const s = set.trim();
  const n = name.trim();
  if (s.length < 1 || s.length > 80 || owner.length > 20 || n.length < 1 || n.length > 40) return null;
  if (color !== undefined && (typeof color !== 'string' || color.length > 40)) return null;
  if (typeof pockets !== 'number' || !POCKETS.includes(pockets)) return null;
  if (extras !== undefined && typeof extras !== 'boolean') return null;
  return { set: s, owner, name: n, color: color ?? null, pockets, extras: extras ?? false };
}
