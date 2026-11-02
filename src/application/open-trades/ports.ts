import type { OpenTrade, OpenTradeBook } from '#domain/open-trades/open-trade.ts';
import type { Result } from '#shared/result.ts';

export interface OpenTradeDraft {
  trades: readonly OpenTrade[];
  /** Set when the trades changed and must be saved. */
  changed: boolean;
}

/** The open trades (open-trades.json). */
export interface OpenTradeShelf {
  read(): Promise<OpenTradeBook>;
  /** Run `work` on a copy as one change: kept (and saved if it says it changed) when it returns ok, discarded otherwise. */
  change<T, E>(work: (draft: OpenTradeDraft) => Result<T, E>): Promise<Result<T, E>>;
}

/** What an open trade looks like to the page. */
export interface OpenTradeView {
  readonly id: string;
  readonly number: number;
  readonly customer: string;
  readonly dealer: OpenTrade['dealer'];
  readonly mine: OpenTrade['mine'];
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** One open trade saved (its view) or closed (null). */
export interface OpenTradeChange {
  readonly id: string;
  readonly trade: OpenTradeView | null;
}

/** Changes to open trades, for open pages. */
export interface OpenTradeNews {
  publish(change: OpenTradeChange): void;
  /** Call `listener` with each change; returns the function that stops it. */
  subscribe(listener: (change: OpenTradeChange) => void): () => void;
}
