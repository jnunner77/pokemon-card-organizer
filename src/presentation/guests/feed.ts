import type { LedgerChanges } from '#application/guests/ports.ts';
import type { GuestCard } from '#domain/guests/guest-card.ts';

/**
 * Live updates for the guest page: what guests see of the cards (the list GET /api/guest/cards
 * returns), as JSON, each time it changes. One feed serves every open guest page: card, binder and
 * settings changes are gathered for `delayMs`, the list is worked out once, and it's sent only if
 * it differs from the last one, so ledger changes guests can't see send nothing.
 */
export class GuestCardFeed {
  readonly #listeners = new Set<(json: string) => void>();
  readonly #list: () => Promise<readonly GuestCard[]>;
  readonly #changes: LedgerChanges;
  readonly #delayMs: number;
  #last: Promise<string> = Promise.resolve('');
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | null = null;

  constructor(list: () => Promise<readonly GuestCard[]>, changes: LedgerChanges, delayMs = 250) {
    this.#list = list;
    this.#changes = changes;
    this.#delayMs = delayMs;
  }

  #json = async (): Promise<string> => JSON.stringify(await this.#list());

  /** The list as last sent (or now, with nobody listening). */
  current(): Promise<string> {
    return this.#unsubscribe ? this.#last : this.#json();
  }

  /** Call `fn` with the list each time it changes; returns the function that stops it. */
  subscribe(fn: (json: string) => void): () => void {
    if (!this.#unsubscribe) {
      this.#last = this.#json();
      this.#unsubscribe = this.#changes.subscribe(() => this.#changed());
    }
    this.#listeners.add(fn);
    return () => {
      if (!this.#listeners.delete(fn) || this.#listeners.size) return;
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#unsubscribe?.();
      this.#unsubscribe = null;
    };
  }

  #changed(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // One list at a time, in order: a slow one never overtakes the next.
      const previous = this.#last;
      this.#last = previous.then(async (before) => {
        const json = await this.#json().catch(() => before);
        if (json === before || !this.#unsubscribe) return before;
        // One guest's broken connection doesn't keep the others from hearing.
        for (const fn of [...this.#listeners])
          try {
            fn(json);
          } catch {
            // that page reconnects by itself
          }
        return json;
      });
    }, this.#delayMs);
  }
}
