import type { Category, Logger } from './log.ts';

// Recovering from failures instead of stopping: background jobs that catch and log their own
// errors and keep running, and saved files that are damaged (cut short by a full disk or a
// crash mid-write) set aside so the server can start from a good copy or its defaults.

const message = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

/** Run a job; an error (thrown or rejected) is logged as an error, never thrown on. */
export function safely(log: Logger, cat: Category, what: string, fn: () => unknown): void {
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((err) => log.error(cat, `${what} failed: ${message(err)}`));
  } catch (err) {
    log.error(cat, `${what} failed: ${message(err)}`);
  }
}

/** Run a job every `ms` (not keeping the server alive), each run guarded by safely(). */
export function every(log: Logger, cat: Category, what: string, ms: number, fn: () => unknown): NodeJS.Timeout {
  const t = setInterval(() => safely(log, cat, what, fn), ms);
  t.unref();
  return t;
}

export { type Damaged, damagedMessage, readJson, setAside } from '#infrastructure/json-store/damaged.ts';
