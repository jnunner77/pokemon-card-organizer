import { type LookupHit, printingsOf, type SearchTry, searchHits, searchPlan } from '#domain/catalog/any-card.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, unavailable } from './errors.ts';
import { readAnyCard } from './read-any-card.ts';

type Deps = Pick<CatalogDeps, 'database' | 'tcgplayer' | 'clock' | 'anyCardPricing'>;

/**
 * Find a card → Any card: cards in the card database matching a query, best first, whether or not
 * they're in the ledger. Each of the query's searches is tried in turn until one finds cards.
 */
export class SearchAnyCard {
  /** How long TCGplayer's set list is left before a search asks for it again. */
  static readonly warmEveryMs = 10 * 60_000;
  #warmedAt = -Infinity;
  /** The cards whose TCGplayer side was fetched ahead, and when. */
  readonly #warmedCards = new Map<string, number>();
  readonly #warming = new Set<Promise<void>>();
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async execute(input: { readonly query: string }): Promise<Result<{ readonly hits: readonly LookupHit[]; readonly more: boolean }, CardDatabaseUnavailable>> {
    const plan = searchPlan(input.query);
    if (!plan) return ok({ hits: [], more: false });
    const db = this.#deps.database;
    try {
      const ask = (t: SearchTry) => (t.by === 'name' ? db.cardsNamed(t.value) : db.cardsNumbered(t.value));
      // The first search goes out alongside the set lists rather than after them.
      const first = plan.tries[0];
      const [sets, pocket, firstList] = await Promise.all([db.sets(), db.pocketSets(), first ? ask(first) : Promise.resolve([])]);
      for (const [i, t] of plan.tries.entries()) {
        const list = i === 0 ? firstList : await ask(t);
        const found = searchHits(list, t, plan.numbers, sets, pocket);
        if (found) {
          const top = found.hits[0];
          if (top) {
            this.#warm();
            this.#warmTop(top.id);
          }
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
   * day doesn't wait for it. Set files are fetched ahead only for the top result (#warmTop), not
   * for every result: that would be a TCGdex request per result and tcgcsv.com downloads for cards
   * nobody opens.
   */
  #warm(): void {
    const tcgplayer = this.#deps.tcgplayer;
    if (!tcgplayer) return;
    const now = this.#deps.clock.now().getTime();
    if (now - this.#warmedAt < SearchAnyCard.warmEveryMs) return;
    this.#warmedAt = now;
    void tcgplayer.groupList().catch(() => undefined);
  }

  /**
   * Fetches the top result's card and, for a printing TCGdex has no TCGplayer price for, its
   * TCGplayer set in the background, since it's the one most likely opened next. Never awaited by
   * a search and never failing it; a card is left alone for warmEveryMs after it was started, and
   * forgotten at once when it fails.
   */
  #warmTop(id: string): void {
    const now = this.#deps.clock.now().getTime();
    for (const [key, at] of this.#warmedCards) if (now - at >= SearchAnyCard.warmEveryMs) this.#warmedCards.delete(key);
    if (this.#warmedCards.has(id)) return;
    this.#warmedCards.set(id, now);
    if (this.#warmedCards.size > 100) {
      const oldest = this.#warmedCards.keys().next();
      if (!oldest.done) this.#warmedCards.delete(oldest.value);
    }
    const work = (async () => {
      const r = await readAnyCard(this.#deps.database, id);
      await this.#deps.anyCardPricing.warm({ card: r.td, setCode: r.setCode, total: r.total, parentSet: r.parentSet, printings: printingsOf(r.td) });
    })()
      .catch(() => void this.#warmedCards.delete(id))
      .finally(() => this.#warming.delete(work));
    this.#warming.add(work);
  }

  /** Resolves when the cards being fetched ahead are done (for tests). */
  idle(): Promise<void> {
    return Promise.all([...this.#warming]).then(() => undefined);
  }
}
