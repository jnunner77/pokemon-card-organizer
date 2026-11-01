import { printingsOf } from '#domain/catalog/any-card.ts';
import { isCardDatabaseId } from '#domain/catalog/tcgdex.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, unavailable } from './errors.ts';
import { type LookupPrinting, SourceUnavailable } from './ports.ts';
import { type AnyCardDetails, detailsOf, readAnyCard } from './read-any-card.ts';

/** One card from the card database, with its printings and each one's prices today. */
export interface LookupCard extends Omit<AnyCardDetails, 'printings'> {
  readonly printings: readonly LookupPrinting[];
  /** CAD per US dollar and per euro. */
  readonly rates: { readonly usd: number };
  /** What couldn't be had: a source that didn't answer, or has no match. */
  readonly notes: readonly string[];
}

export type ShowAnyCardError = { readonly code: 'NO_SUCH_CARD' } | CardDatabaseUnavailable;

/**
 * Find a card → Any card: one card's details, its printings and each one's prices today, worked
 * out the way the daily update would price it. Nothing is saved: the ledger isn't touched.
 */
export class ShowAnyCard {
  readonly #deps: Pick<CatalogDeps, 'database' | 'anyCardPricing'>;

  constructor(deps: Pick<CatalogDeps, 'database' | 'anyCardPricing'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly id: string }): Promise<Result<LookupCard, ShowAnyCardError>> {
    if (!isCardDatabaseId(input.id)) return err({ code: 'NO_SUCH_CARD' });
    const db = this.#deps.database;
    try {
      const r = await readAnyCard(db, input.id);
      const priced = await this.#deps.anyCardPricing.price({ card: r.td, setCode: r.setCode, total: r.total, parentSet: r.parentSet, printings: printingsOf(r.td) });
      // The regular printing's TCGplayer picture is the largest; TCGdex's own otherwise.
      const product = priced.printings.find((p) => p.product)?.product;
      return ok({
        ...detailsOf(r, product),
        printings: priced.printings.map((p) => p.printing),
        rates: priced.rates,
        notes: priced.notes,
      });
    } catch (error) {
      if (error instanceof SourceUnavailable && error.status === 404) return err({ code: 'NO_SUCH_CARD' });
      return err(unavailable(error));
    }
  }
}
