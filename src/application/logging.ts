import type { Category, Level, LogEntry } from '#domain/admin/log.ts';

// The server's log, as every layer above the domain uses it: standard output, a file per day, and
// the recent entries administrators search on the Logs page. Secret-looking values are hidden
// before anything is written.

export interface LogQuery {
  /** This level and above. */
  readonly level?: Level | undefined;
  readonly cat?: Category | undefined;
  /** Text in the message or its details, any case. */
  readonly text?: string | undefined;
  /** Entries older than this id (the next page). */
  readonly before?: number | undefined;
  readonly limit?: number | undefined;
}

export interface LogFileInfo {
  readonly name: string;
  readonly day: string;
  readonly bytes: number;
}

/** A day's log file, ready to send. */
export interface LogFileContent {
  readonly bytes: number;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface ServerLog {
  log(level: Level, cat: Category, msg: string, data?: Record<string, unknown>): LogEntry;
  info(cat: Category, msg: string, data?: Record<string, unknown>): LogEntry;
  warn(cat: Category, msg: string, data?: Record<string, unknown>): LogEntry;
  error(cat: Category, msg: string, data?: Record<string, unknown>): LogEntry;
  /** Recent entries, newest first. */
  query(q?: LogQuery): LogEntry[];
  /**
   * Entries from `from` to `to` (ISO times), oldest first, at most the last `limit`: from the daily
   * files, so they're still there after a restart.
   */
  between(from: string, to: string, q?: { readonly cats?: readonly Category[]; readonly limit?: number }): LogEntry[];
  /** Warnings and errors logged after `since` (all that are kept when null), oldest first. */
  problems(since?: string | null): LogEntry[];
  /** How many entries of each level in the last `sinceMs`. */
  counts(sinceMs: number): Record<Level, number>;
  /** The daily files, newest first. */
  files(): LogFileInfo[];
  /** A daily file by its name, or null when there is no such file. */
  openFile(name: string): Promise<LogFileContent | null>;
  /** Whether the last write to the daily file worked (null before the first). */
  readonly fileOk: boolean | null;
  /** The folder of the daily files; logs only go to the console without one. */
  readonly dir: string | undefined;
}
