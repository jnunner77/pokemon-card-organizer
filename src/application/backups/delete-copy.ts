import { isCopyName } from '#domain/backups/copies.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { BackupDeps } from './deps.ts';
import type { CopyNotFound } from './download-copy.ts';

/** Delete a kept copy. */
export class DeleteCopy {
  readonly #deps: Pick<BackupDeps, 'copies' | 'log'>;

  constructor(deps: Pick<BackupDeps, 'copies' | 'log'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly name: string }): Promise<Result<void, CopyNotFound>> {
    const { copies, log } = this.#deps;
    const exists = isCopyName(input.name) && (await copies.list()).some((c) => c.name === input.name);
    if (!exists) return err({ code: 'COPY_NOT_FOUND' });
    await copies.remove(input.name);
    log.info(`${input.actor} deleted the copy ${input.name}`, { by: input.actor, name: input.name });
    return ok(undefined);
  }
}
