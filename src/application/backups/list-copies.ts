import { type KeptCopy, newestFirst } from '#domain/backups/copies.ts';
import type { Retention } from '#domain/backups/retention.ts';
import type { PhotoUsage } from '../photos/ports.ts';
import type { BackupDeps } from './deps.ts';

export interface CopiesOverview {
  readonly backups: readonly KeptCopy[];
  readonly retention: Retention;
  readonly lastFullBackupAt: string | null;
  readonly photos: PhotoUsage;
}

/** Administration → Backups: the kept copies, retention, the last full backup and the photos. */
export class ListCopies {
  readonly #deps: Pick<BackupDeps, 'copies' | 'settings' | 'photos'>;

  constructor(deps: Pick<BackupDeps, 'copies' | 'settings' | 'photos'>) {
    this.#deps = deps;
  }

  async execute(): Promise<CopiesOverview> {
    const { copies, settings, photos } = this.#deps;
    return { backups: newestFirst(await copies.list()), retention: settings.retention(), lastFullBackupAt: settings.lastFullBackupAt(), photos: await photos.usage() };
  }
}
