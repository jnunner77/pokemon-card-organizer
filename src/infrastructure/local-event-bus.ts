import type { EventPublisher } from '#application/ports.ts';
import type { LedgerEvent } from '#domain/ledger/events.ts';

/** Domain events handed to whoever subscribed, in this process (EVENT_LOG=1 prints them). */
export class LocalEventBus implements EventPublisher {
  readonly #listeners = new Set<(event: LedgerEvent) => void>();

  subscribe(listener: (event: LedgerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  async publish(events: readonly LedgerEvent[]): Promise<void> {
    for (const event of events) for (const listener of this.#listeners) listener(event);
  }
}
