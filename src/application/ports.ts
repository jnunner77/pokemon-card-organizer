import type { LedgerEvent } from '#domain/ledger/events.ts';
import type { Result } from '#shared/result.ts';

export interface Clock {
  now(): Date;
}

export interface EventPublisher {
  publish(events: readonly LedgerEvent[]): Promise<void>;
}

export interface UnitOfWork {
  /**
   * Run `work` as one atomic change. It is saved (and sent to open pages) when the work returns
   * ok, and discarded, leaving nothing changed, when it returns an error or throws.
   */
  run<T, E>(work: () => Promise<Result<T, E>>): Promise<Result<T, E>>;
}

/** The server's activity log: who did what ("Justin sorted Trainers: 3 of 9 cards moved"). */
export interface ActivityLog {
  info(message: string): void;
}
