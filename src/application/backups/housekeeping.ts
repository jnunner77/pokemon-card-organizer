import { dailyCopyName } from '#domain/backups/copies.ts';
import { photosReferencedBy } from '#domain/photos/references.ts';
import { anyOldEnough, purgeable } from '#domain/photos/trash.ts';
import type { BackupDeps } from './deps.ts';
import type { PruneCopies } from './prune-copies.ts';

/**
 * The hourly job: today's daily copy if there isn't one yet (then retention), and old trashed photos
 * deleted once neither the ledger nor any kept copy refers to them.
 */
export class Housekeeping {
  readonly #deps: Pick<BackupDeps, 'copies' | 'photos' | 'ledgerPhotos' | 'clock' | 'log'> & { readonly prune: Pick<PruneCopies, 'execute'> };
  /** The photos the copies refer to, read again only when the copies change. */
  #copiesRefer: { key: string; ids: ReadonlySet<string> } | null = null;

  constructor(deps: Pick<BackupDeps, 'copies' | 'photos' | 'ledgerPhotos' | 'clock' | 'log'> & { readonly prune: Pick<PruneCopies, 'execute'> }) {
    this.#deps = deps;
  }

  async execute(): Promise<{ readonly dailyCopy: boolean; readonly photosPurged: number }> {
    const dailyCopy = await this.#dailyCopy();
    await this.#deps.prune.execute();
    return { dailyCopy, photosPurged: await this.#purgeTrash() };
  }

  async #dailyCopy(): Promise<boolean> {
    const { copies, clock, log } = this.#deps;
    const day = clock.now().toISOString().slice(0, 10);
    const name = dailyCopyName(day);
    if ((await copies.list()).some((c) => c.name === name)) return false;
    if (!(await copies.copyLedgerFile(name))) return false;
    log.info(`Took the daily copy for ${day}`);
    return true;
  }

  async #purgeTrash(): Promise<number> {
    const { photos, ledgerPhotos, clock, log } = this.#deps;
    const now = clock.now();
    const trashed = await photos.trashed();
    if (!anyOldEnough(trashed, now)) return 0;
    const fromCopies = await this.#referencedByCopies();
    if (!fromCopies) return 0;
    const referenced = new Set([...fromCopies, ...(await ledgerPhotos.referenced())]);
    const gone = purgeable(trashed, now, referenced);
    for (const p of gone) await photos.purge(p);
    if (gone.length) log.info(`Deleted ${gone.length} trashed photo${gone.length === 1 ? '' : 's'} that no kept copy of the ledger refers to`);
    return gone.length;
  }

  /** The photos any kept copy refers to, or null when a copy can't be read (then nothing is deleted). */
  async #referencedByCopies(): Promise<ReadonlySet<string> | null> {
    const { copies, log } = this.#deps;
    const list = await copies.list();
    const key = list.map((c) => `${c.name}:${c.bytes}:${c.at}`).join('|');
    if (this.#copiesRefer?.key === key) return this.#copiesRefer.ids;
    const ids = new Set<string>();
    for (const c of list) {
      try {
        const parsed: unknown = JSON.parse((await copies.read(c.name)) ?? '{}');
        photosReferencedBy(parsed, ids);
      } catch (error) {
        log.warn(`Couldn't read the copy ${c.name}, so no trashed photo is deleted: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
    this.#copiesRefer = { key, ids };
    return ids;
  }
}
