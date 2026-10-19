import { err, ok, type Result } from '#shared/result.ts';
import { expected, isIsoDateTime, isRecord } from './input.ts';
import type { Category, Level, LogEntry } from './log.ts';

// Every warning and error the server logs, for the problems banner administrators see on the
// binder and in Administration: the ones since they last marked them as seen, with repeats
// grouped ("12× PriceCharting answered 500"), so nothing that fails goes unnoticed.

export interface ProblemGroup {
  level: Level;
  cat: Category;
  /** The latest message of the group, and its details. */
  msg: string;
  data?: Record<string, unknown> | undefined;
  count: number;
  first: string;
  last: string;
}

export interface ProblemFeed {
  /** When an administrator last marked them as seen. */
  readonly seenAt: string | null;
  readonly errors: number;
  readonly warnings: number;
  /** Newest first, at most 100. */
  readonly groups: readonly ProblemGroup[];
  /** The newest problem's time (what "mark as seen" marks up to). */
  readonly latest: string | null;
}

/** Where the warnings and errors come from: those logged after `since` (all kept when null), oldest first. */
export interface ProblemSource {
  problems(since: string | null): readonly LogEntry[];
}

const MAX_GROUPS = 100;

/** Messages that differ only in numbers, ids or addresses are the same problem. */
export const problemKey = (e: Pick<LogEntry, 'level' | 'cat' | 'msg'>): string =>
  `${e.level}|${e.cat}|${(e.msg.split('\n')[0] ?? '').replace(/\b[0-9a-f]{8,}\b/gi, '…').replace(/\d+(?:[.:]\d+)*/g, '#')}`;

/** Repeats grouped, newest first. */
export function groupProblems(entries: readonly LogEntry[]): ProblemGroup[] {
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

/** The feed for these problems, seen up to `seenAt`. */
export function summarizeProblems(entries: readonly LogEntry[], seenAt: string | null): ProblemFeed {
  let latest: string | null = null;
  for (const e of entries) if (latest === null || e.at > latest) latest = e.at;
  return {
    seenAt,
    errors: entries.filter((e) => e.level === 'error').length,
    warnings: entries.filter((e) => e.level === 'warn').length,
    groups: groupProblems(entries).slice(0, MAX_GROUPS),
    latest,
  };
}

/** The problems since `seenAt` (or all that are kept, with `all`). */
export function problemFeed(source: ProblemSource, seenAt: string | null, o: { readonly all?: boolean } = {}): ProblemFeed {
  return summarizeProblems(source.problems(o.all ? null : seenAt), seenAt);
}

/**
 * When "mark as seen" marks up to: the newest problem the page showed, so one logged meanwhile
 * still counts as new; now, when the page didn't say or said a time still to come.
 */
export const seenUpTo = (upTo: string | undefined, now: Date): string => (upTo !== undefined && upTo < now.toISOString() ? upTo : now.toISOString());

export type InvalidSeenMark = { readonly code: 'INVALID_SEEN_MARK'; readonly message: string };

/** "Mark as seen" as the page sent it: nothing, or { upTo } the newest problem it showed (an ISO time). */
export function checkSeenMark(input: unknown): Result<string | undefined, InvalidSeenMark> {
  const invalid = (message: string) => err<InvalidSeenMark>({ code: 'INVALID_SEEN_MARK', message });
  if (input === undefined) return ok(undefined);
  if (!isRecord(input)) return invalid(expected('object', input));
  const upTo = input['upTo'];
  if (upTo === undefined) return ok(undefined);
  if (typeof upTo !== 'string') return invalid(expected('string', upTo));
  return isIsoDateTime(upTo) ? ok(upTo) : invalid('Invalid ISO datetime');
}
