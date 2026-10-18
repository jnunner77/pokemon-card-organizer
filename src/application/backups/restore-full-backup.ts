import { checkBackupPhoto, type InvalidBackup, readFullBackup } from '#domain/backups/full-backup.ts';
import { isPhotoId, type PhotoId, type PhotoType } from '#domain/photos/photo.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { BackupDeps } from './deps.ts';

export interface RestoreSummary {
  readonly binders: number;
  readonly cards: number;
  readonly photos: number;
  /** Cards whose photo id isn't in the backup or on this server (they show "No photo"). */
  readonly missingPhotos: number;
}

/**
 * Replace the ledger with a full backup. Everything is checked before anything is written, the
 * current ledger is kept as a before-restore copy, and photos keep their ids. Photos already on
 * this server stay.
 */
export class RestoreFullBackup {
  readonly #deps: Pick<BackupDeps, 'ledger' | 'photos' | 'base64' | 'log'>;

  constructor(deps: Pick<BackupDeps, 'ledger' | 'photos' | 'base64' | 'log'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly backup: unknown }): Promise<Result<RestoreSummary, InvalidBackup>> {
    const { ledger, photos, base64, log } = this.#deps;
    const read = readFullBackup(input.backup);
    if (!read.ok) return read;
    const decoded = Object.entries(read.value.photos).map(([id, p]) => ({ id, bytes: base64.decode(p.data) }));
    // Empty photos first, then ones that aren't pictures, as before.
    for (const p of decoded) {
      if (p.bytes.length) continue;
      const refused = checkBackupPhoto(p.id, p.bytes);
      if (!refused.ok) return refused;
    }
    const ready: { id: PhotoId; type: PhotoType; bytes: Uint8Array }[] = [];
    for (const p of decoded) {
      const type = checkBackupPhoto(p.id, p.bytes);
      if (!type.ok) return type;
      if (!isPhotoId(p.id)) return err({ code: 'INVALID_BACKUP', message: `assets.${p.id}: Photo ids are 32 hex characters` });
      ready.push({ id: p.id, type: type.value, bytes: p.bytes });
    }
    for (const p of ready) await photos.save(p.id, p.type, p.bytes);
    await ledger.replace(read.value.ledger);
    let missing = 0;
    for (const card of Object.values(read.value.ledger.cards)) {
      const imageId = card['imageId'];
      if (typeof imageId === 'string' && !imageId.startsWith('data:') && !(isPhotoId(imageId) && (await photos.has(imageId)))) missing++;
    }
    const summary = { binders: Object.keys(read.value.ledger.binders).length, cards: Object.keys(read.value.ledger.cards).length, photos: ready.length, missingPhotos: missing };
    log.warn(`${input.actor} restored a full backup`, { ...summary });
    return ok(summary);
  }
}
