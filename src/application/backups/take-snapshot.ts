import { type KeptCopy, snapshotName } from '#domain/backups/copies.ts';
import type { BackupDeps } from './deps.ts';
import type { PruneCopies } from './prune-copies.ts';

/** An administrator's copy of the ledger as it is now, kept until deleted (the newest 50). */
export class TakeSnapshot {
  readonly #deps: Pick<BackupDeps, 'copies' | 'ledger' | 'clock' | 'log'> & { readonly prune: Pick<PruneCopies, 'execute'> };

  constructor(deps: Pick<BackupDeps, 'copies' | 'ledger' | 'clock' | 'log'> & { readonly prune: Pick<PruneCopies, 'execute'> }) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly label?: string | undefined }): Promise<KeptCopy> {
    const { copies, ledger, clock, log, prune } = this.#deps;
    const name = snapshotName(clock.now(), input.label);
    await copies.writeLedger(name, await ledger.current());
    log.info(`${input.actor} took a snapshot${input.label ? ` "${input.label}"` : ''}`, { by: input.actor, name });
    await prune.execute();
    const taken = (await copies.list()).find((c) => c.name === name);
    if (!taken) throw new Error(`The snapshot ${name} was written but isn't among the copies`);
    return taken;
  }
}
