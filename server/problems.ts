import type { Category, Level, LogEntry, Logger } from './log';

// Every warning and error the server logs, for the problems banner administrators see on the
// binder and in Administration: the ones since they last marked them as seen, with repeats
// grouped ("12× PriceCharting answered 500"), so nothing that fails goes unnoticed.

export interface ProblemGroup {
  level: Level;
  cat: Category;
  /** The latest message of the group, and its details. */
  msg: string;
  data?: Record<string, unknown>;
  count: number;
  first: string;
  last: string;
}

export interface ProblemFeed {
  /** When an administrator last marked them as seen. */
  seenAt: string | null;
  errors: number;
  warnings: number;
  /** Newest first, at most 100. */
  groups: ProblemGroup[];
  /** The newest problem's time (what "mark as seen" marks up to). */
  latest: string | null;
}

/** Messages that differ only in numbers, ids or addresses are the same problem. */
export const problemKey = (e: Pick<LogEntry, 'level' | 'cat' | 'msg'>) =>
  `${e.level}|${e.cat}|${e.msg
    .split('\n')[0]
    .replace(/\b[0-9a-f]{8,}\b/gi, '…')
    .replace(/\d+(?:[.:]\d+)*/g, '#')}`;

/** Repeats grouped, newest first. */
export function groupProblems(entries: LogEntry[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  for (const e of entries) {
    const k = problemKey(e);
    const g = groups.get(k);
    if (!g) groups.set(k, { level: e.level, cat: e.cat, msg: e.msg, ...(e.data ? { data: e.data } : {}), count: 1, first: e.at, last: e.at });
    else {
      g.count++;
      if (e.at < g.first) g.first = e.at;
      if (e.at >= g.last) Object.assign(g, { last: e.at, msg: e.msg, data: e.data });
    }
  }
  // Newest first; errors before warnings at the same moment.
  return [...groups.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

/** The problems since `seenAt` (or all that are kept, with `all`). */
export function problemFeed(log: Logger, seenAt: string | null, o: { all?: boolean } = {}): ProblemFeed {
  const entries = log.problems(o.all ? null : seenAt);
  const groups = groupProblems(entries);
  return {
    seenAt,
    errors: entries.filter((e) => e.level === 'error').length,
    warnings: entries.filter((e) => e.level === 'warn').length,
    groups: groups.slice(0, 100),
    latest: entries.length ? entries.reduce((m, e) => (e.at > m ? e.at : m), entries[0].at) : null,
  };
}
