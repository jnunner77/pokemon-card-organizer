import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import { ok, type Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';

/** Take every sold or traded card out of its binder, page and pocket (cards sold before that rule). */
export class TakeSoldCardsOutOfBinders {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<Result<{ readonly moved: number }, InvalidDocument>> {
    const now = this.#deps.clock.now();
    const done = await commit<{ readonly moved: number }, InvalidDocument>(this.#deps, async () => {
      const changed = [];
      for (const card of await this.#deps.cards.all()) {
        const taken = card.takeOutIfSold(now);
        if (!taken.ok) return taken;
        if (taken.value) changed.push(card);
      }
      for (const card of changed) await this.#deps.cards.save(card);
      return ok({ value: { moved: changed.length }, events: changed.flatMap((c) => c.pullEvents()) });
    });
    if (!done.ok) return done;
    const { moved } = done.value;
    if (moved > 0) this.#deps.activity.info(`Took ${moved} sold or traded card${moved === 1 ? '' : 's'} out of their binders`);
    return done;
  }
}
