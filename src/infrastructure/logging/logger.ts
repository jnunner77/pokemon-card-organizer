import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { LogFileContent, LogFileInfo, LogQuery, ServerLog } from '#application/logging.ts';
import { type Category, isLogFileName, type Level, LEVELS, type LogEntry, redact } from '#domain/admin/log.ts';

// The server's log: every line goes to standard output (so `docker compose logs` shows it), to a
// file per day under <data>/logs (kept for two weeks), and to a recent-entries list that
// administrators can search on the Logs page. Values whose names look secret (passwords, tokens,
// cookies) are replaced before anything is written.

export interface LoggerOptions {
  /** Folder for the daily files; no files without one. */
  readonly dir?: string | undefined;
  readonly keepDays?: number | undefined;
  /** Entries kept in memory for the Logs page. */
  readonly recent?: number | undefined;
  readonly stdout?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Warnings and errors kept for the problems feed. */
const PROBLEMS_KEPT = 3000;

/** Each line of a daily file that parses (a line cut short when the server stopped doesn't). */
function* entriesIn(text: string, keep: (line: string) => boolean = () => true): Generator<LogEntry> {
  for (const line of text.split('\n')) {
    if (!line || !keep(line)) continue;
    try {
      // Lines this logger wrote itself.
      yield JSON.parse(line) as LogEntry;
    } catch {
      // a line cut short when the server stopped
    }
  }
}

export class Logger implements ServerLog {
  readonly #entries: LogEntry[] = [];
  #nextId = 1;
  readonly #dir: string | undefined;
  readonly #keepDays: number;
  readonly #max: number;
  readonly #stdout: boolean;
  readonly #now: () => Date;
  #currentDay = '';
  #fileOk: boolean | null = null;
  /** Warnings and errors for the problems feed: read from the daily files at start, then as they're logged. */
  readonly #problems: LogEntry[] = [];

  constructor(opts: LoggerOptions = {}) {
    this.#dir = opts.dir;
    this.#keepDays = opts.keepDays ?? 14;
    this.#max = opts.recent ?? 5000;
    this.#stdout = opts.stdout ?? true;
    this.#now = opts.now ?? (() => new Date());
    if (this.#dir) {
      fs.mkdirSync(this.#dir, { recursive: true });
      this.#loadProblems(this.#dir);
    }
  }

  get dir(): string | undefined {
    return this.#dir;
  }

  /** Whether the last write to the daily file worked (shown on the overview). */
  get fileOk(): boolean | null {
    return this.#fileOk;
  }

  /** The warnings and errors still in the daily files (the last two weeks), so they outlast a restart. */
  #loadProblems(dir: string): void {
    for (const f of this.files().reverse()) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, f.name), 'utf8');
      } catch {
        continue;
      }
      for (const e of entriesIn(text, (line) => /"level":\s*"(?:warn|error)"/.test(line))) this.#problems.push(e);
    }
    if (this.#problems.length > PROBLEMS_KEPT) this.#problems.splice(0, this.#problems.length - PROBLEMS_KEPT);
  }

  problems(since: string | null = null): LogEntry[] {
    return since ? this.#problems.filter((e) => e.at > since) : this.#problems.slice();
  }

  log(level: Level, cat: Category, msg: string, data?: Record<string, unknown>): LogEntry {
    const hidden = data ? redact(data) : undefined;
    const entry: LogEntry = { id: this.#nextId++, at: this.#now().toISOString(), level, cat, msg, ...(hidden && typeof hidden === 'object' && !Array.isArray(hidden) ? { data: { ...hidden } } : {}) };
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) this.#entries.splice(0, this.#entries.length - this.#max);
    if (level !== 'info') {
      this.#problems.push(entry);
      if (this.#problems.length > PROBLEMS_KEPT) this.#problems.splice(0, this.#problems.length - PROBLEMS_KEPT);
    }
    const line = JSON.stringify(entry);
    if (this.#stdout) (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
    this.#toFile(entry.at.slice(0, 10), line);
    return entry;
  }

  info(cat: Category, msg: string, data?: Record<string, unknown>): LogEntry {
    return this.log('info', cat, msg, data);
  }

  warn(cat: Category, msg: string, data?: Record<string, unknown>): LogEntry {
    return this.log('warn', cat, msg, data);
  }

  error(cat: Category, msg: string, data?: Record<string, unknown>): LogEntry {
    return this.log('error', cat, msg, data);
  }

  #toFile(day: string, line: string): void {
    if (!this.#dir) return;
    try {
      if (day !== this.#currentDay) {
        this.#currentDay = day;
        this.#prune(this.#dir);
      }
      fs.appendFileSync(path.join(this.#dir, `${day}.jsonl`), line + '\n', { mode: 0o600 });
      this.#fileOk = true;
    } catch {
      this.#fileOk = false;
    }
  }

  /** Delete daily files older than keepDays. */
  #prune(dir: string): void {
    const cutoff = new Date(this.#now().getTime() - this.#keepDays * 86_400_000).toISOString().slice(0, 10);
    for (const f of this.files()) if (f.day < cutoff) fs.rmSync(path.join(dir, f.name), { force: true });
  }

  files(): LogFileInfo[] {
    const dir = this.#dir;
    if (!dir || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(isLogFileName)
      .sort()
      .reverse()
      .map((name) => ({ name, day: name.slice(0, 10), bytes: fs.statSync(path.join(dir, name)).size }));
  }

  async openFile(name: string): Promise<LogFileContent | null> {
    if (!this.#dir || !isLogFileName(name)) return null;
    const file = path.join(this.#dir, name);
    try {
      const { size } = await fs.promises.stat(file);
      // Today's file keeps growing: send only the bytes counted, as the length says.
      return { bytes: size, content: size > 0 ? fs.createReadStream(file, { end: size - 1 }) : Readable.from([]) };
    } catch {
      return null;
    }
  }

  query(q: LogQuery = {}): LogEntry[] {
    const min = q.level ? LEVELS.indexOf(q.level) : 0;
    const text = q.text?.toLowerCase();
    const limit = q.limit ?? 200;
    const out: LogEntry[] = [];
    for (let i = this.#entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.#entries[i];
      if (!e) continue;
      if (q.before && e.id >= q.before) continue;
      if (LEVELS.indexOf(e.level) < min || (q.cat && e.cat !== q.cat)) continue;
      if (text && !`${e.msg} ${JSON.stringify(e.data ?? {})}`.toLowerCase().includes(text)) continue;
      out.push(e);
    }
    return out;
  }

  between(from: string, to: string, q: { readonly cats?: readonly Category[]; readonly limit?: number } = {}): LogEntry[] {
    const limit = q.limit ?? 300;
    const keep = (e: LogEntry) => e.at >= from && e.at <= to && (!q.cats || q.cats.includes(e.cat));
    const dir = this.#dir;
    if (!dir) return this.#entries.filter(keep).slice(-limit);
    const out: LogEntry[] = [];
    const days = this.files()
      .filter((f) => f.day >= from.slice(0, 10) && f.day <= to.slice(0, 10))
      .reverse();
    for (const f of days) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, f.name), 'utf8');
      } catch {
        continue;
      }
      for (const e of entriesIn(text)) if (keep(e)) out.push(e);
    }
    return out.slice(-limit);
  }

  counts(sinceMs: number): Record<Level, number> {
    const since = new Date(this.#now().getTime() - sinceMs).toISOString();
    const c: Record<Level, number> = { info: 0, warn: 0, error: 0 };
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const e = this.#entries[i];
      if (!e || e.at < since) break;
      c[e.level]++;
    }
    return c;
  }
}

/** A logger that writes nowhere, for tests and tools. */
export const quietLogger = (): Logger => new Logger({ stdout: false });
