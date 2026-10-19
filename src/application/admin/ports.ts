import type { LastPriceRun, PriceRunProblem, SecuritySummary } from '#domain/admin/checks.ts';
import type { OffsiteCopy } from '#domain/admin/offsite.ts';
import type { TokenState } from '#domain/admin/pricecharting-token.ts';
import type { AdminSettings } from '#domain/admin/settings.ts';

/** The settings only administrators change (admin.json), outside the ledger. */
export interface AdminSettingsStore {
  get(): AdminSettings;
  /** Change some of them; the settings after the change. */
  set(patch: Partial<AdminSettings>): AdminSettings;
}

/**
 * A secret the server keeps for an outside service (PriceCharting's API token), outside the data
 * that's backed up. Only the server reads it; only whether one is saved, and when, is ever shown.
 */
export interface TokenVault {
  /** The value, or null when none is saved. */
  read(): string | null;
  info(): TokenState;
  write(value: string): void;
  clear(): void;
}

export type TokenCheck = { readonly outcome: 'accepted' } | { readonly outcome: 'refused' } | { readonly outcome: 'failed'; readonly message: string };

/** PriceCharting's API, as Administration uses it. */
export interface PriceChartingAccount {
  /** One call with this token: whether PriceCharting accepts it. */
  check(token: string): Promise<TokenCheck>;
  /** Drop what was remembered from PriceCharting (its token changed or went). */
  forget(): void;
  /** How PriceCharting is being used today (calls made, the daily budget, a pause). */
  usage(): unknown;
}

/** The daily price update's schedule as it applies it. */
export interface PriceUpdateSchedule {
  readonly enabled: boolean;
  readonly hour: number;
  readonly timeZone: string;
  readonly [more: string]: unknown;
}

/** The daily price and picture update, on a server that has one. */
export interface PriceUpdates {
  schedule(): PriceUpdateSchedule;
  /** The settings or the PriceCharting token changed: the update's saved state follows. */
  noteToken(): void;
}

/** What the daily update saved about its runs. */
export interface PriceUpdateRecord {
  /** Its saved state as it is (progress, the current card, a problem, recent runs), for the Prices page. */
  saved(): Readonly<Record<string, unknown>>;
  /** For the overview's checks. */
  summary(): { readonly lastRun: LastPriceRun | null; readonly running: boolean; readonly problem: PriceRunProblem | null; readonly rateDate: string | null };
}

/** Rate limits and blocks, for the overview's checks. */
export interface SecurityWatch {
  summary(): SecuritySummary;
}

export interface DiskUsage {
  /** Free space where the data is kept, or null when it can't be told. */
  freeBytes(): Promise<number | null>;
  /** How much the data directory holds. */
  dataBytes(): Promise<number>;
}

/** status.txt, which the server's nightly job reads and alerts on. */
export interface StatusFile {
  write(text: string): Promise<void>;
}

/** offsite.json, which the server's nightly job writes after copying a backup off the server. */
export interface OffsiteRecord {
  latest(): Promise<OffsiteCopy | null>;
}

export interface ServerRuntime {
  info(): { readonly node: string; readonly uptimeSeconds: number; readonly startedAt: Date };
}
