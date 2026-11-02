import type { OpenTradeChange, OpenTradeNews } from '#application/open-trades/ports.ts';

/** Open trade changes handed to whoever subscribed, in this process. */
export class LocalOpenTradeNews implements OpenTradeNews {
  readonly #listeners = new Set<(change: OpenTradeChange) => void>();

  publish(change: OpenTradeChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch {
        // One listener failing must not stop the others, or the save that made the news.
      }
    }
  }

  subscribe(listener: (change: OpenTradeChange) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }
}
