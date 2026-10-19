import type { LogEntry } from '#domain/admin/log.ts';
import type { LogFileInfo, LogQuery } from '../logging.ts';
import type { AdminDeps } from './deps.ts';

/** The Logs page: recent entries matching a search, newest first, and the daily files. */
export class SearchLogs {
  readonly #deps: Pick<AdminDeps, 'log'>;

  constructor(deps: Pick<AdminDeps, 'log'>) {
    this.#deps = deps;
  }

  execute(query: LogQuery): { readonly entries: readonly LogEntry[]; readonly files: readonly LogFileInfo[] } {
    return { entries: this.#deps.log.query({ ...query, limit: query.limit ?? 200 }), files: this.#deps.log.files() };
  }
}
