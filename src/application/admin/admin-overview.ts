import type { Check } from '#domain/admin/checks.ts';
import type { PhotoUsage } from '../photos/ports.ts';
import type { AdminDeps } from './deps.ts';
import type { OverviewChecks, RequestFacts } from './overview-checks.ts';

export interface AdminOverviewReport {
  readonly checks: readonly Check[];
  readonly ledger: { readonly binders: number; readonly cards: number } & PhotoUsage;
  readonly server: { readonly node: string; readonly uptimeHours: number; readonly startedAt: string };
}

/** Administration's front page: the checks, how big the ledger is, and the server. */
export class AdminOverview {
  readonly #deps: Pick<AdminDeps, 'ledger' | 'photos' | 'runtime'> & { readonly checks: Pick<OverviewChecks, 'execute'> };

  constructor(deps: Pick<AdminDeps, 'ledger' | 'photos' | 'runtime'> & { readonly checks: Pick<OverviewChecks, 'execute'> }) {
    this.#deps = deps;
  }

  async execute(request: RequestFacts): Promise<AdminOverviewReport> {
    const checks = await this.#deps.checks.execute(request);
    const all = await this.#deps.ledger.read();
    const runtime = this.#deps.runtime.info();
    return {
      checks,
      ledger: { binders: all.binders.length, cards: all.cards.length, ...(await this.#deps.photos.usage()) },
      server: { node: runtime.node, uptimeHours: Math.round(runtime.uptimeSeconds / 360) / 10, startedAt: runtime.startedAt.toISOString() },
    };
  }
}
