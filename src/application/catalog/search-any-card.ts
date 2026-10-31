import { type LookupHit, searchHits, searchPlan } from '#domain/catalog/any-card.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, unavailable } from './errors.ts';

/**
 * Find a card → Any card: cards in the card database matching a query, best first, whether or not
 * they're in the ledger. Each of the query's searches is tried in turn until one finds cards.
 */
export class SearchAnyCard {
  /** How long TCGplayer's set list is left before a search asks for it again. */
  static readonly warmEveryMs = 10 * 60_000;
  #warmedAt = -Infinity;
  readonly #deps: Pick<CatalogDeps, 'database' | 'tcgplayer' | 'clock'>;

  constructor(deps: Pick<CatalogDeps, 'database' | 'tcgplayer' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly query: string }): Promise<Result<{ readonly hits: readonly LookupHit[]; readonly more: boolean }, CardDatabaseUnavailable>> {
    const plan = searchPlan(input.query);
    if (!plan) return ok({ hits: [], more: false });
    const db = this.#deps.database;
    try {
      const [sets, pocket] = await Promise.all([db.sets(), db.pocketSets()]);
      for (const t of plan.tries) {
        const list = t.by === 'name' ? await db.cardsNamed(t.value) : await db.cardsNumbered(t.value);
        const found = searchHits(list, t, plan.numbers, sets, pocket);
        if (found) {
          if (found.hits.length > 0) this.#warm();
          return ok(found);
        }
      }
      return ok({ hits: [], more: false });
    } catch (error) {
      return err(unavailable(error));
    }
  }

  /**
   * Asks TCGplayer's catalog for its set list in the background, so the first card looked at each
   * day doesn't wait for it. Set files aren't fetched ahead: that would be a TCGdex request per
   * result and tcgcsv.com downloads for cards nobody opens.
   */
  #warm(): void {
    const tcgplayer = this.#deps.tcgplayer;
    if (!tcgplayer) return;
    const now = this.#deps.clock.now().getTime();
    if (now - this.#warmedAt < SearchAnyCard.warmEveryMs) return;
    this.#warmedAt = now;
    void tcgplayer.groupList().catch(() => undefined);
  }
}
