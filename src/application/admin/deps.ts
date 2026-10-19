import type { AccountsHealth } from '../accounts/accounts-health.ts';
import type { EnvPasswordWorks } from '../accounts/env-password-works.ts';
import type { BackupHealth } from '../backups/backup-health.ts';
import type { LedgerReader } from '../ledger/ledger-reader.ts';
import type { ServerLog } from '../logging.ts';
import type { PhotoStore } from '../photos/ports.ts';
import type { Clock } from '../ports.ts';
import type { AdminSettingsStore, DiskUsage, OffsiteRecord, PriceChartingAccount, PriceUpdateRecord, PriceUpdates, SecurityWatch, ServerRuntime, StatusFile, TokenVault } from './ports.ts';

/** Sign-in, for the overview's checks; null with sign-in turned off (AUTH=off). */
export interface AccountChecks {
  readonly health: Pick<AccountsHealth, 'execute'>;
  readonly envPasswordWorks: Pick<EnvPasswordWorks, 'execute'>;
  /** BINDER_PASSWORD, which should no longer open the "admin" account. */
  readonly envPassword: string | undefined;
}

export interface AdminDeps {
  readonly settings: AdminSettingsStore;
  readonly log: ServerLog;
  readonly clock: Clock;
  readonly disk: DiskUsage;
  readonly statusFile: StatusFile;
  readonly offsite: OffsiteRecord;
  readonly runtime: ServerRuntime;
  readonly ledger: LedgerReader;
  readonly photos: Pick<PhotoStore, 'usage'>;
  readonly backups: Pick<BackupHealth, 'execute'>;
  readonly accounts: AccountChecks | null;
  readonly security: SecurityWatch;
  /** Null on a server without the daily price update. */
  readonly prices: PriceUpdates | null;
  readonly priceRecord: PriceUpdateRecord;
  /** PriceCharting's token and API; null on a server without them. */
  readonly pricecharting: { readonly token: TokenVault; readonly account: PriceChartingAccount } | null;
}
