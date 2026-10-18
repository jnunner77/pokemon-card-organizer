import { newestFirst } from '#domain/backups/copies.ts';
import type { Retention } from '#domain/backups/retention.ts';
import type { BackupDeps } from './deps.ts';

export interface BackupHealthReport {
  /** When the newest daily copy was taken, or null when there is none. */
  readonly newestDaily: string | null;
  readonly dailyCopies: number;
  readonly snapshots: number;
  readonly bytes: number;
  readonly retention: Retention;
}

/** For the Administration overview's checks: the newest daily copy and how much is kept. */
export class BackupHealth {
  readonly #deps: Pick<BackupDeps, 'copies' | 'settings'>;

  constructor(deps: Pick<BackupDeps, 'copies' | 'settings'>) {
    this.#deps = deps;
  }

  async execute(): Promise<BackupHealthReport> {
    const copies = newestFirst(await this.#deps.copies.list());
    const daily = copies.filter((c) => c.kind === 'daily');
    return {
      newestDaily: daily[0]?.at ?? null,
      dailyCopies: daily.length,
      snapshots: copies.filter((c) => c.kind === 'snapshot').length,
      bytes: copies.reduce((t, c) => t + c.bytes, 0),
      retention: this.#deps.settings.retention(),
    };
  }
}
