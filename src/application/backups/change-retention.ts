import { checkRetention, type InvalidRetention, type Retention } from '#domain/backups/retention.ts';
import { ok, type Result } from '#shared/result.ts';
import type { BackupDeps } from './deps.ts';
import type { PruneCopies } from './prune-copies.ts';

/** Change how many daily, weekly and monthly copies are kept, and drop the ones no longer kept. */
export class ChangeRetention {
  readonly #deps: Pick<BackupDeps, 'settings' | 'adminLog'> & { readonly prune: Pick<PruneCopies, 'execute'> };

  constructor(deps: Pick<BackupDeps, 'settings' | 'adminLog'> & { readonly prune: Pick<PruneCopies, 'execute'> }) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly retention: unknown }): Promise<Result<{ readonly retention: Retention; readonly removed: number }, InvalidRetention>> {
    const retention = checkRetention(input.retention);
    if (!retention.ok) return retention;
    this.#deps.settings.setRetention(retention.value);
    const removed = await this.#deps.prune.execute();
    this.#deps.adminLog.info(`${input.actor} changed backup retention`, { ...retention.value, removed });
    return ok({ retention: retention.value, removed });
  }
}
