import { isLogFileName } from '#domain/admin/log.ts';
import type { LogFileContent } from '../logging.ts';
import type { AdminDeps } from './deps.ts';

/** A day's log file to download, or null when there is no such file. */
export class OpenLogFile {
  readonly #deps: Pick<AdminDeps, 'log'>;

  constructor(deps: Pick<AdminDeps, 'log'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly name: string }): Promise<LogFileContent | null> {
    return isLogFileName(input.name) ? this.#deps.log.openFile(input.name) : null;
  }
}
