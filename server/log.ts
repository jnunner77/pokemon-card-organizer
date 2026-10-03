import fs from 'node:fs';
import path from 'node:path';

// The server's log: every line goes to standard output (so `docker compose logs` shows it),
// to a file per day under <data>/logs (kept for two weeks), and to a recent-entries list that
// administrators can search on the Logs page. Values whose names look secret (passwords,
// tokens, cookies) are replaced before anything is written.

export type Level = 'info' | 'warn' | 'error';
export type Category = 'http' | 'auth' | 'admin' | 'security' | 'pricing' | 'backup' | 'app';
export const LEVELS: Level[] = ['info', 'warn', 'error'];
export const CATEGORIES: Category[] = ['http', 'auth', 'admin', 'security', 'pricing', 'backup', 'app'];

export interface LogEntry {
  id: number;
  at: string;
  level: Level;
  cat: Category;
  msg: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Folder for the daily files; no files without one. */
  dir?: string;
  keepDays?: number;
  /** Entries kept in memory for the Logs page. */
  recent?: number;
  stdout?: boolean;
  now?: () => Date;
}

const SECRET = /password|token|secret|cookie|authorization|setupcode/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null || typeof value !== 'object') return typeof value === 'string' && value.length > 2000 ? value.slice(0, 2000) + '…' : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '[hidden]' : redact(v, depth + 1);
  return out;
}

export class Logger {
  private readonly entries: LogEntry[] = [];
  private nextId = 1;
  private readonly keepDays: number;
  private readonly max: number;
  private readonly stdout: boolean;
  private readonly now: () => Date;
  private currentDay = '';
  /** Whether the last write to the daily file worked (shown on the Checks page). */
  fileOk: boolean | null = null;

  constructor(readonly opts: LoggerOptions = {}) {
    this.keepDays = opts.keepDays ?? 14;
    this.max = opts.recent ?? 5000;
    this.stdout = opts.stdout ?? true;
    this.now = opts.now ?? (() => new Date());
    if (opts.dir) fs.mkdirSync(opts.dir, { recursive: true });
  }

  get dir() {
    return this.opts.dir;
  }

  log(level: Level, cat: Category, msg: string, data?: Record<string, unknown>): LogEntry {
    const entry: LogEntry = { id: this.nextId++, at: this.now().toISOString(), level, cat, msg, ...(data ? { data: redact(data) as Record<string, unknown> } : {}) };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    const line = JSON.stringify(entry);
    if (this.stdout) (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
    this.toFile(entry.at.slice(0, 10), line);
    return entry;
  }

  info(cat: Category, msg: string, data?: Record<string, unknown>) {
    return this.log('info', cat, msg, data);
  }
  warn(cat: Category, msg: string, data?: Record<string, unknown>) {
    return this.log('warn', cat, msg, data);
  }
  error(cat: Category, msg: string, data?: Record<string, unknown>) {
    return this.log('error', cat, msg, data);
  }

  private toFile(day: string, line: string) {
    if (!this.opts.dir) return;
    try {
      if (day !== this.currentDay) {
        this.currentDay = day;
        this.prune();
      }
      fs.appendFileSync(path.join(this.opts.dir, `${day}.jsonl`), line + '\n', { mode: 0o600 });
      this.fileOk = true;
    } catch {
      this.fileOk = false;
    }
  }

  /** Delete daily files older than keepDays. */
  private prune() {
    const cutoff = new Date(this.now().getTime() - this.keepDays * 86_400_000).toISOString().slice(0, 10);
    for (const f of this.files()) if (f.day < cutoff) fs.rmSync(path.join(this.opts.dir!, f.name), { force: true });
  }

  files(): { name: string; day: string; bytes: number }[] {
    if (!this.opts.dir || !fs.existsSync(this.opts.dir)) return [];
    return fs
      .readdirSync(this.opts.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse()
      .map((name) => ({ name, day: name.slice(0, 10), bytes: fs.statSync(path.join(this.opts.dir!, name)).size }));
  }

  /** Recent entries, newest first. */
  query(q: { level?: Level; cat?: Category; text?: string; before?: number; limit?: number } = {}): LogEntry[] {
    const min = q.level ? LEVELS.indexOf(q.level) : 0;
    const text = q.text?.toLowerCase();
    const out: LogEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < (q.limit ?? 200); i--) {
      const e = this.entries[i];
      if (q.before && e.id >= q.before) continue;
      if (LEVELS.indexOf(e.level) < min || (q.cat && e.cat !== q.cat)) continue;
      if (text && !`${e.msg} ${JSON.stringify(e.data ?? {})}`.toLowerCase().includes(text)) continue;
      out.push(e);
    }
    return out;
  }

  /** How many entries of each level since a time (from the in-memory list). */
  counts(sinceMs: number) {
    const since = new Date(this.now().getTime() - sinceMs).toISOString();
    const c: Record<Level, number> = { info: 0, warn: 0, error: 0 };
    for (let i = this.entries.length - 1; i >= 0 && this.entries[i].at >= since; i--) c[this.entries[i].level]++;
    return c;
  }
}

/** A logger that writes nowhere, for tests and tools. */
export const quietLogger = () => new Logger({ stdout: false });
