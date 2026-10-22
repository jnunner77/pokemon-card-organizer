import { cardIdentity } from '#domain/catalog/details.ts';
import type { AutofillCard } from './autofill-card.ts';
import type { BackfillDetails } from './backfill-details.ts';
import type { CatalogDeps } from './deps.ts';
import { messageOf } from './errors.ts';

export interface WatchNewCardsOptions {
  /** How long after starting to look up cards checked before an update (null: don't). */
  readonly backfillAfterMs: number | null;
}

/**
 * New cards fill themselves in: as soon as a card is added (the form, a CSV import, the API) or
 * becomes a different card (a CSV row replacing it, or its name or number edited), it's queued
 * and filled in (AutofillCard), one at a time with a pause between, so a big import doesn't
 * hammer the sites. Cards already there, or brought back by a restore, aren't new. Shortly after
 * it starts, cards looked up before the current checks are looked up again (BackfillDetails).
 */
export class WatchNewCards {
  readonly #deps: Pick<CatalogDeps, 'changes' | 'scheduler' | 'log' | 'delayMs'>;
  readonly #autofill: Pick<AutofillCard, 'execute'>;
  readonly #backfill: Pick<BackfillDetails, 'execute'>;
  readonly #backfillAfterMs: number | null;
  /** Each card's name and number, to notice when a card becomes a different one. */
  #known = new Map<string, string>();
  readonly #queue: string[] = [];
  /** Queued cards that were a different card before (their old automatic match is dropped). */
  readonly #changed = new Set<string>();
  #working: Promise<void> | null = null;
  #unsubscribe: (() => void) | null = null;
  #cancelBackfill: (() => void) | null = null;

  constructor(deps: Pick<CatalogDeps, 'changes' | 'scheduler' | 'log' | 'delayMs'> & { readonly autofill: Pick<AutofillCard, 'execute'>; readonly backfill: Pick<BackfillDetails, 'execute'> }, options: WatchNewCardsOptions) {
    this.#deps = deps;
    this.#autofill = deps.autofill;
    this.#backfill = deps.backfill;
    this.#backfillAfterMs = options.backfillAfterMs;
  }

  /** Start watching. */
  execute(): void {
    if (this.#unsubscribe) return;
    const { changes, scheduler, log } = this.#deps;
    const snapshot = () => new Map(changes.current().map((c) => [c.id, cardIdentity(c.card)]));
    this.#known = snapshot();
    this.#unsubscribe = changes.subscribe((change) => {
      if (change.kind === 'replaced') {
        this.#known = snapshot();
        return;
      }
      const { id, card } = change;
      if (!card) {
        this.#known.delete(id);
        return;
      }
      const now = cardIdentity(card);
      const before = this.#known.get(id);
      if (before === now) return;
      this.#known.set(id, now);
      if (before !== undefined) this.#changed.add(id);
      this.#enqueue(id);
    });
    if (this.#backfillAfterMs !== null)
      this.#cancelBackfill = scheduler.after(this.#backfillAfterMs, () => {
        this.#backfill.execute().catch((error: unknown) => log.error(`Looking up cards again after an update failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
      });
  }

  /** Stop watching (the server is stopping): the card being filled in finishes, the rest aren't started. */
  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#cancelBackfill?.();
    this.#cancelBackfill = null;
    this.#queue.length = 0;
    this.#changed.clear();
  }

  /** Resolves when every queued card has been handled. */
  idle(): Promise<void> {
    return this.#working ?? Promise.resolve();
  }

  #enqueue(id: string): void {
    if (!this.#queue.includes(id)) this.#queue.push(id);
    this.#working ??= this.#drain()
      .catch((error: unknown) => this.#deps.log.error(`Filling in new cards stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`))
      .finally(() => {
        this.#working = null;
      });
  }

  async #drain(): Promise<void> {
    const { scheduler, log, delayMs } = this.#deps;
    // Let the request that added the card finish first (and a CSV import add the rest).
    await scheduler.pause(200);
    for (let id = this.#queue.shift(); id !== undefined; id = this.#queue.shift()) {
      try {
        await this.#autofill.execute({ cardId: id, changed: this.#changed.delete(id) });
      } catch (error) {
        log.warn(`Filling in a new card failed: ${messageOf(error)}`);
      }
      if (this.#queue.length) await scheduler.pause(delayMs);
    }
  }
}
