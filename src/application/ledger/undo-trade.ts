import { type TradeError, undoTrade } from '#domain/ledger/trade.ts';
import type { Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';
import { saveTrade, type TradeView } from './trade-view.ts';

export interface UndoTradeInput {
  readonly actor: string;
  readonly tradeId: string;
}

/** Undo a recorded trade: my cards back where they were, the cards it added gone, its placeholders back. */
export class UndoTrade {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(input: UndoTradeInput): Promise<Result<TradeView, TradeError>> {
    const now = this.#deps.clock.now();
    const done = await commit<TradeView, TradeError>(this.#deps, async () => {
      const change = undoTrade(input.tradeId, await this.#deps.cards.all(), await this.#deps.binders.all(), now);
      return change.ok ? saveTrade(this.#deps, change.value) : change;
    });
    if (done.ok) this.#deps.activity.info(`${input.actor} undid a trade`);
    return done;
  }
}
