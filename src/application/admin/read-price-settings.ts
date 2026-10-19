import type { TokenState } from '#domain/admin/pricecharting-token.ts';
import type { AdminDeps } from './deps.ts';
import type { PriceUpdateSchedule } from './ports.ts';

export interface PriceSettingsReport {
  /** Whether this server has the daily price update. */
  readonly available: boolean;
  readonly schedule: PriceUpdateSchedule | null;
  /** Whether PriceCharting's token is saved and when (never the token), and today's use of it. */
  readonly pricecharting: (TokenState & { readonly usage: unknown }) | null;
  readonly running: boolean;
  readonly done: unknown;
  readonly total: unknown;
  readonly current: unknown;
  readonly problem: unknown;
  readonly history: unknown;
}

/** Administration → Prices: the schedule, PriceCharting's token state and the update's progress. */
export class ReadPriceSettings {
  readonly #deps: Pick<AdminDeps, 'prices' | 'priceRecord' | 'pricecharting'>;

  constructor(deps: Pick<AdminDeps, 'prices' | 'priceRecord' | 'pricecharting'>) {
    this.#deps = deps;
  }

  execute(): PriceSettingsReport {
    const { prices, pricecharting } = this.#deps;
    const st = this.#deps.priceRecord.saved();
    return {
      available: prices !== null,
      schedule: prices?.schedule() ?? null,
      pricecharting: pricecharting ? { ...pricecharting.token.info(), usage: pricecharting.account.usage() } : null,
      running: !!st['running'],
      done: st['done'] ?? 0,
      total: st['total'] ?? 0,
      current: st['current'] ?? null,
      problem: st['problem'] ?? null,
      history: st['history'] ?? (st['lastRun'] ? [st['lastRun']] : []),
    };
  }
}
