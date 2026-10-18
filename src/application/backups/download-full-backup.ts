import { type BackupPhoto, type FullBackup, fullBackup } from '#domain/backups/full-backup.ts';
import type { BackupDeps } from './deps.ts';

/** Everything as one file to keep somewhere else: binders, cards, settings and every photo. */
export class DownloadFullBackup {
  readonly #deps: Pick<BackupDeps, 'ledger' | 'photos' | 'base64' | 'settings' | 'clock' | 'log'>;

  constructor(deps: Pick<BackupDeps, 'ledger' | 'photos' | 'base64' | 'settings' | 'clock' | 'log'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string }): Promise<{ readonly filename: string; readonly backup: FullBackup }> {
    const { ledger, photos, base64, settings, clock, log } = this.#deps;
    const now = clock.now();
    settings.noteFullBackup(now);
    log.info(`${input.actor} downloaded a full backup`);
    const files: Record<string, BackupPhoto> = {};
    for (const id of await photos.list()) {
      const photo = await photos.read(id);
      if (photo) files[id] = { type: photo.type, data: base64.encode(photo.bytes) };
    }
    return { filename: `binder-ledger-backup-${now.toISOString().slice(0, 10)}.json`, backup: fullBackup(await ledger.current(), files, now) };
  }
}
