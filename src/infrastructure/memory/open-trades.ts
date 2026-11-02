import type { OpenTradeDraft, OpenTradeShelf } from '#application/open-trades/ports.ts';
import type { OpenTradeBook } from '#domain/open-trades/open-trade.ts';
import type { Result } from '#shared/result.ts';

// Open trades kept in memory, for tests.

export class MemoryOpenTradeShelf implements OpenTradeShelf {
  #book: OpenTradeBook = { trades: [] };
  /** How many times the trades were saved. */
  saves = 0;

  async read(): Promise<OpenTradeBook> {
    return { trades: this.#book.trades };
  }

  async change<T, E>(work: (draft: OpenTradeDraft) => Result<T, E>): Promise<Result<T, E>> {
    const draft: OpenTradeDraft = { trades: this.#book.trades, changed: false };
    const result = work(draft);
    if (!result.ok || !draft.changed) return result;
    this.#book = { trades: draft.trades };
    this.saves++;
    return result;
  }
}
