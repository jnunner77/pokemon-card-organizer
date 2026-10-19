import type { AdminSettingsStore, DiskUsage, OffsiteRecord, PriceChartingAccount, PriceUpdateRecord, PriceUpdates, PriceUpdateSchedule, SecurityWatch, ServerRuntime, StatusFile, TokenCheck, TokenVault } from '#application/admin/ports.ts';
import type { LastPriceRun, PriceRunProblem, SecuritySummary } from '#domain/admin/checks.ts';
import type { OffsiteCopy } from '#domain/admin/offsite.ts';
import type { TokenState } from '#domain/admin/pricecharting-token.ts';
import { type AdminSettings, DEFAULT_ADMIN_SETTINGS } from '#domain/admin/settings.ts';

// Administration's ports in memory, for application tests.

export class MemoryAdminSettings implements AdminSettingsStore {
  current: AdminSettings = DEFAULT_ADMIN_SETTINGS;

  get(): AdminSettings {
    return structuredClone(this.current);
  }

  set(patch: Partial<AdminSettings>): AdminSettings {
    this.current = { ...this.current, ...patch };
    return this.get();
  }
}

export class MemoryTokenVault implements TokenVault {
  value: string | null = null;
  savedAt: string | null = null;
  now: () => Date = () => new Date(0);

  read(): string | null {
    return this.value;
  }

  info(): TokenState {
    return { set: this.value !== null, savedAt: this.value === null ? null : this.savedAt };
  }

  write(value: string): void {
    this.value = value;
    this.savedAt = this.now().toISOString();
  }

  clear(): void {
    this.value = null;
  }
}

/** PriceCharting accepting the tokens in `known`, refusing others; `failure` makes every check fail. */
export class MemoryPriceCharting implements PriceChartingAccount {
  readonly known = new Set<string>();
  failure: string | null = null;
  forgotten = 0;

  async check(token: string): Promise<TokenCheck> {
    if (this.failure !== null) return { outcome: 'failed', message: this.failure };
    return this.known.has(token) ? { outcome: 'accepted' } : { outcome: 'refused' };
  }

  forget(): void {
    this.forgotten++;
  }

  usage(): unknown {
    return { calls: 0, limit: 2000 };
  }
}

export class MemoryPriceUpdates implements PriceUpdates {
  current: PriceUpdateSchedule = { enabled: true, hour: 5, timeZone: 'America/Vancouver' };
  noted = 0;

  schedule(): PriceUpdateSchedule {
    return this.current;
  }

  noteToken(): void {
    this.noted++;
  }
}

export class MemoryPriceUpdateRecord implements PriceUpdateRecord {
  state: Readonly<Record<string, unknown>> = {};
  lastRun: LastPriceRun | null = null;
  problem: PriceRunProblem | null = null;
  rateDate: string | null = null;

  saved(): Readonly<Record<string, unknown>> {
    return this.state;
  }

  summary(): { readonly lastRun: LastPriceRun | null; readonly running: boolean; readonly problem: PriceRunProblem | null; readonly rateDate: string | null } {
    return { lastRun: this.lastRun, running: !!this.state['running'], problem: this.problem, rateDate: this.rateDate };
  }
}

export class MemorySecurityWatch implements SecurityWatch {
  current: SecuritySummary = { enabled: true, bans: 0, limited: 0, blocked: 0, allowlist: 0 };

  summary(): SecuritySummary {
    return this.current;
  }
}

export class MemoryDisk implements DiskUsage {
  free: number | null = 10 * 1024 * 1048576;
  data = 1048576;

  async freeBytes(): Promise<number | null> {
    return this.free;
  }

  async dataBytes(): Promise<number> {
    return this.data;
  }
}

export class MemoryStatusFile implements StatusFile {
  text: string | null = null;

  async write(text: string): Promise<void> {
    this.text = text;
  }
}

export class MemoryOffsiteRecord implements OffsiteRecord {
  copy: OffsiteCopy | null = null;

  async latest(): Promise<OffsiteCopy | null> {
    return this.copy;
  }
}

export class FixedRuntime implements ServerRuntime {
  info(): { readonly node: string; readonly uptimeSeconds: number; readonly startedAt: Date } {
    return { node: 'v22.18.0', uptimeSeconds: 5400, startedAt: new Date('2026-10-18T10:30:00.000Z') };
  }
}
