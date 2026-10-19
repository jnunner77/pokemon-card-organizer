import { AdminOverview } from '#application/admin/admin-overview.ts';
import { ChangePriceMethod } from '#application/admin/change-price-method.ts';
import { ChangePriceSchedule } from '#application/admin/change-price-schedule.ts';
import type { AccountChecks, AdminDeps } from '#application/admin/deps.ts';
import { ListProblems } from '#application/admin/list-problems.ts';
import { MarkProblemsSeen } from '#application/admin/mark-problems-seen.ts';
import { OpenLogFile } from '#application/admin/open-log-file.ts';
import { OverviewChecks } from '#application/admin/overview-checks.ts';
import { ReadPriceSettings } from '#application/admin/read-price-settings.ts';
import { RemovePriceChartingToken } from '#application/admin/remove-pricecharting-token.ts';
import { ReportPageError } from '#application/admin/report-page-error.ts';
import { SavePriceChartingToken } from '#application/admin/save-pricecharting-token.ts';
import { SearchLogs } from '#application/admin/search-logs.ts';
import { WriteStatusFile } from '#application/admin/write-status-file.ts';
import { FixedRuntime, MemoryAdminSettings, MemoryDisk, MemoryOffsiteRecord, MemoryPriceCharting, MemoryPriceUpdateRecord, MemoryPriceUpdates, MemorySecurityWatch, MemoryStatusFile, MemoryTokenVault } from '#infrastructure/memory/admin.ts';
import { MemoryLedger } from '#infrastructure/memory/ledger.ts';
import { MemoryPhotoStore } from '#infrastructure/memory/photos.ts';
import { Logger } from '#infrastructure/logging/logger.ts';

/** Administration's dependencies in memory, on a clock the test moves. */
export function setUp(o: { readonly prices?: boolean; readonly pricecharting?: boolean; readonly accounts?: AccountChecks | null } = {}) {
  let now = new Date('2026-10-03T12:00:00.000Z');
  const clock = { now: () => now };
  const log = new Logger({ stdout: false, now: clock.now });
  const settings = new MemoryAdminSettings();
  const ledger = new MemoryLedger();
  const prices = new MemoryPriceUpdates();
  const priceRecord = new MemoryPriceUpdateRecord();
  const token = new MemoryTokenVault();
  token.now = clock.now;
  const account = new MemoryPriceCharting();
  const statusFile = new MemoryStatusFile();
  const offsite = new MemoryOffsiteRecord();
  const security = new MemorySecurityWatch();
  const disk = new MemoryDisk();
  const deps: AdminDeps = {
    settings,
    log,
    clock,
    disk,
    statusFile,
    offsite,
    runtime: new FixedRuntime(),
    ledger: ledger.reader,
    photos: new MemoryPhotoStore(),
    backups: { execute: async () => ({ newestDaily: '2026-10-03T00:05:00.000Z', dailyCopies: 2, snapshots: 0, bytes: 10, retention: { daily: 14, weekly: 8, monthly: 12 } }) },
    accounts: o.accounts === undefined ? null : o.accounts,
    security,
    prices: o.prices === false ? null : prices,
    priceRecord,
    pricecharting: o.pricecharting === false ? null : { token, account },
  };
  const checks = new OverviewChecks(deps);
  return {
    deps,
    log,
    settings,
    ledger,
    prices,
    priceRecord,
    token,
    account,
    statusFile,
    offsite,
    security,
    disk,
    setNow: (d: Date) => void (now = d),
    checks,
    overview: new AdminOverview({ ...deps, checks }),
    writeStatusFile: new WriteStatusFile({ ...deps, checks }),
    readPriceSettings: new ReadPriceSettings(deps),
    changePriceSchedule: new ChangePriceSchedule(deps),
    changePriceMethod: new ChangePriceMethod(deps),
    saveToken: new SavePriceChartingToken(deps),
    removeToken: new RemovePriceChartingToken(deps),
    listProblems: new ListProblems(deps),
    markProblemsSeen: new MarkProblemsSeen(deps),
    searchLogs: new SearchLogs(deps),
    openLogFile: new OpenLogFile(deps),
    reportPageError: new ReportPageError(deps),
  };
}
