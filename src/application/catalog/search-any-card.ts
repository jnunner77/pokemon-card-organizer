import { type LookupHit, searchHits, searchPlan } from '#domain/catalog/any-card.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, unavailable } from './errors.ts';

/**
 * Find a card → Any card: cards in the card database matching a query, best first, whether or not
 * they're in the ledger. Each of the query's searches is tried in turn until one finds cards.
 */
export class SearchAnyCard {
  readonly #deps: Pick<CatalogDeps, 'database'>;

  constructor(deps: Pick<CatalogDeps, 'database'>) {
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
        if (found) return ok(found);
      }
      return ok({ hits: [], more: false });
    } catch (error) {
      return err(unavailable(error));
    }
  }
}
