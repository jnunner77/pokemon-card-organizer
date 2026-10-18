import { copiesToDrop } from '#domain/backups/copies.ts';
import type { BackupDeps } from './deps.ts';

/** Delete the copies retention no longer keeps; how many went. */
export class PruneCopies {
  readonly #deps: Pick<BackupDeps, 'copies' | 'settings' | 'log'>;

  constructor(deps: Pick<BackupDeps, 'copies' | 'settings' | 'log'>) {
    this.#deps = deps;
  }

  async execute(): Promise<number> {
    const drop = copiesToDrop(await this.#deps.copies.list(), this.#deps.settings.retention());
    for (const c of drop) await this.#deps.copies.remove(c.name);
    if (drop.length) this.#deps.log.info(`Removed ${drop.length} old cop${drop.length === 1 ? 'y' : 'ies'} of the ledger`, { names: drop.map((c) => c.name) });
    return drop.length;
  }
}
