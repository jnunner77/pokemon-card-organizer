import { recordTrade, type TradeError, type TradeRecord } from '#domain/ledger/trade.ts';
import type { Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';
import { saveTrade, type TradeView } from './trade-view.ts';

export interface RecordTradeInput extends TradeRecord {
  /** Who is recording it, for the activity log. */
  readonly actor: string;
}

const plural = (n: number) => `${n} card${n === 1 ? '' : 's'}`;

/** Record a trade with a dealer: my cards traded away and theirs added or filling placeholders, all at once. */
export class RecordTrade {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(input: RecordTradeInput): Promise<Result<TradeView, TradeError>> {
    const now = this.#deps.clock.now();
    const done = await commit<TradeView, TradeError>(this.#deps, async () => {
      const change = recordTrade(input, await this.#deps.cards.all(), await this.#deps.binders.all(), now);
      return change.ok ? saveTrade(this.#deps, change.value) : change;
    });
    if (done.ok) this.#deps.activity.info(`${input.actor} recorded a trade: ${plural(input.given.length)} traded away, ${plural(input.received.length)} in`);
    return done;
  }
}
