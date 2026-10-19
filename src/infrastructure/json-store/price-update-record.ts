import type { PriceUpdateRecord } from '#application/admin/ports.ts';
import type { LastPriceRun, PriceRunProblem } from '#domain/admin/checks.ts';
import type { Store } from './store.ts';

// What the daily price update saved in the ledger's settings: its state (settings/pricing) and the
// date of the exchange rate it uses (settings/main).

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);

function lastRunFrom(v: unknown): LastPriceRun | null {
  if (!isRecord(v) || typeof v['date'] !== 'string' || typeof v['finishedAt'] !== 'string') return null;
  const counts: Record<string, number> = {};
  if (isRecord(v['counts'])) for (const [k, n] of Object.entries(v['counts'])) if (typeof n === 'number') counts[k] = n;
  return { date: v['date'], finishedAt: v['finishedAt'], counts };
}

function problemFrom(v: unknown): PriceRunProblem | null {
  if (!isRecord(v)) return null;
  const recoveredAt = v['recoveredAt'];
  return { title: String(v['title'] ?? ''), message: String(v['message'] ?? ''), ...(typeof recoveredAt === 'string' || recoveredAt === null ? { recoveredAt } : {}) };
}

export class StorePriceUpdateRecord implements PriceUpdateRecord {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  saved(): Readonly<Record<string, unknown>> {
    return this.#store.get('settings', 'pricing') ?? {};
  }

  summary(): { readonly lastRun: LastPriceRun | null; readonly running: boolean; readonly problem: PriceRunProblem | null; readonly rateDate: string | null } {
    const st = this.saved();
    const rateDate = this.#store.get('settings', 'main')?.['usdToCadDate'];
    return { lastRun: lastRunFrom(st['lastRun']), running: !!st['running'], problem: problemFrom(st['problem']), rateDate: typeof rateDate === 'string' ? rateDate : null };
  }
}
