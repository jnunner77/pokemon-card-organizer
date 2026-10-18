import { placeCards, type Placement, type PlaceError } from '#domain/ledger/place.ts';
import { ok, type Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';

export interface PlaceCardsInput {
  /** Who is moving them, for the activity log. */
  readonly actor: string;
  readonly placements: readonly Placement[];
}

/** Move cards to other binders, pages and pockets (or out of every binder), all at once. */
export class PlaceCards {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(input: PlaceCardsInput): Promise<Result<{ readonly moved: number }, PlaceError>> {
    const now = this.#deps.clock.now();
    const done = await commit<{ readonly moved: number }, PlaceError>(this.#deps, async () => {
      const placed = placeCards(input.placements, await this.#deps.cards.all(), await this.#deps.binders.all(), now);
      if (!placed.ok) return placed;
      for (const card of placed.value) await this.#deps.cards.save(card);
      return ok({ value: { moved: placed.value.length }, events: placed.value.flatMap((c) => c.pullEvents()) });
    });
    if (!done.ok) return done;
    const { moved } = done.value;
    this.#deps.activity.info(`${input.actor} moved ${moved} card${moved === 1 ? '' : 's'}`);
    return done;
  }
}
