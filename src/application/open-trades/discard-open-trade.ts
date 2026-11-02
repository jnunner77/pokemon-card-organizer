import { documentId, type InvalidId } from '#domain/ledger/ids.ts';
import { discardOpenTrade, type OpenTradeId } from '#domain/open-trades/open-trade.ts';
import { ok, type Result } from '#shared/result.ts';
import type { OpenTradeDeps } from './deps.ts';

export interface DiscardOpenTradeInput {
  readonly actor: string;
  readonly id: string;
  /** Why it closes: thrown away (default) or recorded as a trade. */
  readonly reason?: 'discarded' | 'recorded' | undefined;
}

/** Close an open trade; nothing happens when it is already gone. */
export class DiscardOpenTrade {
  readonly #deps: OpenTradeDeps;

  constructor(deps: OpenTradeDeps) {
    this.#deps = deps;
  }

  async execute(input: DiscardOpenTradeInput): Promise<Result<{ readonly discarded: boolean }, InvalidId>> {
    const id = documentId<OpenTradeId>(input.id);
    if (!id.ok) return id;
    const done = await this.#deps.shelf.change((draft) => {
      const removed = discardOpenTrade(draft, id.value);
      draft.changed = removed !== null;
      return ok(removed);
    });
    if (!done.ok || !done.value) return ok({ discarded: false });
    this.#deps.news.publish({ id: id.value, trade: null });
    const n = done.value.number;
    this.#deps.activity.info(input.reason === 'recorded' ? `${input.actor} closed Trade ${n}: recorded` : `${input.actor} discarded Trade ${n}`, { by: input.actor, trade: n });
    return ok({ discarded: true });
  }
}
