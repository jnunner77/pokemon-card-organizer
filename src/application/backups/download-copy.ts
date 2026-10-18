import { isCopyName } from '#domain/backups/copies.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { BackupDeps } from './deps.ts';

export type CopyNotFound = { readonly code: 'COPY_NOT_FOUND' };

/** A kept copy's file, to download. */
export class DownloadCopy {
  readonly #deps: Pick<BackupDeps, 'copies'>;

  constructor(deps: Pick<BackupDeps, 'copies'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly name: string }): Promise<Result<{ readonly name: string; readonly text: string }, CopyNotFound>> {
    const text = isCopyName(input.name) ? await this.#deps.copies.read(input.name) : null;
    return text === null ? err({ code: 'COPY_NOT_FOUND' }) : ok({ name: input.name, text });
  }
}
