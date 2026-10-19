import { type Check, runChecks } from '#domain/admin/checks.ts';
import type { AdminDeps } from './deps.ts';

const DAY_MS = 86_400_000;

/** What the request itself tells the checks; the status file uses a request over HTTPS from outside. */
export interface RequestFacts {
  readonly secure: boolean;
  /** A proxy forwarded it but the server isn't told to trust proxies. */
  readonly untrustedProxy: boolean;
  /** From this computer. */
  readonly localRequest: boolean;
}

/** The Administration overview's checks: is this server ready for the internet, and healthy? */
export class OverviewChecks {
  readonly #deps: Omit<AdminDeps, 'statusFile' | 'runtime' | 'ledger' | 'photos' | 'pricecharting'>;

  constructor(deps: Omit<AdminDeps, 'statusFile' | 'runtime' | 'ledger' | 'photos' | 'pricecharting'>) {
    this.#deps = deps;
  }

  async execute(request: RequestFacts): Promise<Check[]> {
    const d = this.#deps;
    const now = d.clock.now();
    const counts = d.log.counts(DAY_MS);
    const failed = d.log.query({ cat: 'auth', text: 'failed sign-in', limit: 5000 }).filter((e) => now.getTime() - Date.parse(e.at) < DAY_MS).length;
    const schedule = d.prices?.schedule();
    const record = d.priceRecord.summary();
    return runChecks({
      now,
      ...request,
      authEnabled: d.accounts !== null,
      accounts: d.accounts ? await d.accounts.health.execute() : null,
      envPasswordStillWorks: d.accounts ? await d.accounts.envPasswordWorks.execute({ envPassword: d.accounts.envPassword }) : false,
      security: d.security.summary(),
      failedSignIns24h: failed,
      backups: await d.backups.execute(),
      lastFullBackupAt: d.settings.get().lastFullBackupAt,
      offsite: await d.offsite.latest(),
      logs: { fileOk: d.log.fileOk, dir: d.log.dir, errors24h: counts.error, warnings24h: counts.warn },
      pricing: { enabled: schedule?.enabled ?? false, hour: schedule?.hour ?? 5, timeZone: schedule?.timeZone ?? '', ...record },
      disk: { freeBytes: await d.disk.freeBytes(), dataBytes: await d.disk.dataBytes() },
    });
  }
}
