import { isCopyName } from '#domain/backups/copies.ts';
import { readLedgerCopy } from '#domain/backups/full-backup.ts';
import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import { isPhotoId } from '#domain/photos/photo.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { BackupDeps } from './deps.ts';
import type { CopyNotFound } from './download-copy.ts';

/**
 * Put a kept copy back as the ledger. The current ledger is kept first (a before-restore copy), and
 * trashed photos the copy needs come back.
 */
export class RestoreCopy {
  readonly #deps: Pick<BackupDeps, 'copies' | 'ledger' | 'photos' | 'ledgerPhotos' | 'log'>;

  constructor(deps: Pick<BackupDeps, 'copies' | 'ledger' | 'photos' | 'ledgerPhotos' | 'log'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly name: string }): Promise<Result<{ readonly cards: number; readonly photosRecovered: number }, CopyNotFound | InvalidDocument>> {
    const { copies, ledger, photos, ledgerPhotos, log } = this.#deps;
    const text = isCopyName(input.name) ? await copies.read(input.name) : null;
    if (text === null) return err({ code: 'COPY_NOT_FOUND' });
    const parsed: unknown = JSON.parse(text);
    const copy = readLedgerCopy(parsed);
    if (!copy.ok) return copy;
    await ledger.replace(copy.value);
    let recovered = 0;
    for (const id of await ledgerPhotos.referenced()) {
      if (isPhotoId(id) && !(await photos.has(id)) && (await photos.untrash(id))) recovered++;
    }
    log.warn(`${input.actor} restored the ledger from ${input.name}`, { by: input.actor, name: input.name, photosRecovered: recovered });
    return ok({ cards: Object.keys(copy.value.cards).length, photosRecovered: recovered });
  }
}
