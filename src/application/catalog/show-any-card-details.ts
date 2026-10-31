import { printingsOf } from '#domain/catalog/any-card.ts';
import { isCardDatabaseId } from '#domain/catalog/tcgdex.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { unavailable } from './errors.ts';
import { SourceUnavailable } from './ports.ts';
import { type AnyCardDetails, detailsOf, readAnyCard } from './read-any-card.ts';
import type { ShowAnyCardError } from './show-any-card.ts';

/**
 * Find a card → Any card: one card's details and printings, without its prices, so the page can
 * show it while they're worked out (show-any-card.ts).
 */
export class ShowAnyCardDetails {
  readonly #deps: Pick<CatalogDeps, 'database'>;

  constructor(deps: Pick<CatalogDeps, 'database'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly id: string }): Promise<Result<AnyCardDetails, ShowAnyCardError>> {
    if (!isCardDatabaseId(input.id)) return err({ code: 'NO_SUCH_CARD' });
    try {
      const r = await readAnyCard(this.#deps.database, input.id);
      const printings = printingsOf(r.td);
      // What the full answer pictures the card by before TCGplayer's catalog is asked.
      const product = printings.find((p) => p.tcgplayer?.productId)?.tcgplayer?.productId;
      return ok({ ...detailsOf(r, product), printings: printings.map((p) => ({ label: p.label, variant: p.variant })) });
    } catch (error) {
      if (error instanceof SourceUnavailable && error.status === 404) return err({ code: 'NO_SUCH_CARD' });
      return err(unavailable(error));
    }
  }
}
