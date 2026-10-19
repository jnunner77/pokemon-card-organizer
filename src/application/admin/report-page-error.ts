import { checkPageError, countPageError, describePageError, type InvalidPageError, NO_PAGE_ERRORS, type PageErrorWindow } from '#domain/admin/page-errors.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AdminDeps } from './deps.ts';

/**
 * A script error or failed promise in a page, logged as an error. Every report counts towards the
 * 30 a minute, even one that turns out malformed; past them, reports are dropped unread.
 */
export class ReportPageError {
  readonly #deps: Pick<AdminDeps, 'log' | 'clock'>;
  #window: PageErrorWindow = NO_PAGE_ERRORS;

  constructor(deps: Pick<AdminDeps, 'log' | 'clock'>) {
    this.#deps = deps;
  }

  /** `by`: who saw it ({ user } or { guest: true }), added to its details. */
  execute(input: { readonly report: unknown; readonly by: Readonly<Record<string, unknown>> }): Result<void, InvalidPageError> {
    const { verdict, window } = countPageError(this.#window, this.#deps.clock.now().getTime());
    this.#window = window;
    if (verdict === 'warn') this.#deps.log.warn('app', 'More than 30 page errors in a minute; not logging more until the minute is up');
    if (verdict !== 'log') return ok(undefined);
    const report = checkPageError(input.report);
    if (!report.ok) return report;
    const { message, details } = describePageError(report.value);
    this.#deps.log.error('app', message, { ...details, ...input.by });
    return ok(undefined);
  }
}
