// The server's log entries: every line has a level and a category, and values whose names look
// secret (passwords, tokens, cookies) are hidden before anything is written.

export type Level = 'info' | 'warn' | 'error';
export type Category = 'http' | 'auth' | 'admin' | 'security' | 'pricing' | 'backup' | 'app';
export const LEVELS: readonly Level[] = ['info', 'warn', 'error'];
export const CATEGORIES: readonly Category[] = ['http', 'auth', 'admin', 'security', 'pricing', 'backup', 'app'];

export const isLevel = (value: unknown): value is Level => LEVELS.some((l) => l === value);
export const isCategory = (value: unknown): value is Category => CATEGORIES.some((c) => c === value);

export interface LogEntry {
  readonly id: number;
  readonly at: string;
  readonly level: Level;
  readonly cat: Category;
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}

const SECRET = /password|token|secret|cookie|authorization|setupcode/i;

/** The value with secret-looking fields hidden, long text cut and deep or long structures trimmed. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null || typeof value !== 'object') return typeof value === 'string' && value.length > 2000 ? value.slice(0, 2000) + '…' : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v: unknown) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '[hidden]' : redact(v, depth + 1);
  return out;
}

/** A day's log file: 2026-10-18.jsonl. */
export const isLogFileName = (name: string): boolean => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
