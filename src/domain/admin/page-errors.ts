import { err, ok, type Result } from '#shared/result.ts';
import { expected, isRecord, numberProblem, textProblem } from './input.ts';

// Script errors and failed promises in the pages are reported to the server and logged, so they show
// in the problems banner like any other. At most 30 a minute, so a page stuck in a loop can't flood
// the log: past that, one warning, then nothing until the minute is up.

export const PAGE_ERRORS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

export interface PageErrorWindow {
  readonly startedAt: number;
  readonly count: number;
  readonly warned: boolean;
}

export const NO_PAGE_ERRORS: PageErrorWindow = { startedAt: 0, count: 0, warned: false };

/** What to do with one more report: log it, warn once that more are being dropped, or drop it. */
export type PageErrorVerdict = 'log' | 'warn' | 'drop';

/** One more report at `nowMs`: what to do with it, and the window after it. */
export function countPageError(window: PageErrorWindow, nowMs: number): { readonly verdict: PageErrorVerdict; readonly window: PageErrorWindow } {
  const current = nowMs - window.startedAt > MINUTE_MS ? { startedAt: nowMs, count: 0, warned: false } : window;
  const count = current.count + 1;
  if (count <= PAGE_ERRORS_PER_MINUTE) return { verdict: 'log', window: { ...current, count } };
  return { verdict: current.warned ? 'drop' : 'warn', window: { ...current, count, warned: true } };
}

/** A page error as the browser reported it. */
export interface PageError {
  readonly kind: 'error' | 'rejection';
  readonly message: string;
  readonly page?: string | undefined;
  readonly source?: string | undefined;
  readonly line?: number | undefined;
  readonly col?: number | undefined;
  readonly stack?: string | undefined;
}

export type InvalidPageError = { readonly code: 'INVALID_PAGE_ERROR'; readonly message: string };

const MAX_LINE = 1e7;

/** A page error report as the page's error handler sent it. Fields it doesn't know are dropped; an unknown kind is an error. */
export function checkPageError(input: unknown): Result<PageError, InvalidPageError> {
  const invalid = (message: string) => err<InvalidPageError>({ code: 'INVALID_PAGE_ERROR', message });
  if (!isRecord(input)) return invalid(expected('object', input));
  const { kind, message, page, source, line, col, stack } = input;
  const optionalText = (v: unknown, max: number) => (v === undefined ? null : textProblem(v, { max }));
  const optionalCount = (v: unknown) => (v === undefined ? null : numberProblem(v, { int: true, min: 0, max: MAX_LINE }));
  const problem = textProblem(message, { max: 500 }) ?? optionalText(page, 200) ?? optionalText(source, 300) ?? optionalCount(line) ?? optionalCount(col) ?? optionalText(stack, 2000);
  if (problem !== null || typeof message !== 'string') return invalid(problem ?? expected('string', message));
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const count = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return ok({ kind: kind === 'rejection' ? 'rejection' : 'error', message, page: text(page), source: text(source), line: count(line), col: count(col), stack: text(stack) });
}

/** The log line for a page error, and its details. */
export function describePageError(e: PageError): { readonly message: string; readonly details: Record<string, unknown> } {
  return {
    message: `Page error${e.page ? ` on ${e.page}` : ''}: ${e.message}`,
    details: { kind: e.kind, ...(e.source ? { at: `${e.source}:${e.line ?? '?'}:${e.col ?? '?'}` } : {}), ...(e.stack ? { stack: e.stack } : {}) },
  };
}
