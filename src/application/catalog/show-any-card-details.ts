import { printingsOf } from '#domain/catalog/any-card.ts';
import { isCardDatabaseId } from '#domain/catalog/tcgdex.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { JapaneseNotReady, stillBuilding, unavailable } from './errors.ts';
import { SourceUnavailable } from './ports.ts';
import { type AnyCardDetails, detailsOf, readAnyCard } from './read-any-card.ts';
import { readJapaneseCard } from './read-japanese-card.ts';
import type { ShowAnyCardError } from './show-any-card.ts';

/**
 * Find a card → Any card: one card's details and printings, without its prices, so the page can
 * show it while they're worked out (show-any-card.ts).
 */
export class ShowAnyCardDetails {
  readonly #deps: Pick<CatalogDeps, 'database' | 'japanese'>;

  constructor(deps: Pick<CatalogDeps, 'database' | 'japanese'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly id: string; readonly language: 'en' | 'ja' }): Promise<Result<AnyCardDetails, ShowAnyCardError>> {
    if (!isCardDatabaseId(input.id)) return err({ code: 'NO_SUCH_CARD' });
    try {
      if (input.language === 'ja') {
        const japanese = this.#deps.japanese;
        if (!japanese) return err({ code: 'JAPANESE_LOOKUPS_OFF' });
        const { entry, details } = await readJapaneseCard(japanese, input.id);
        return ok({ ...details, printings: [{ label: 'regular', variant: entry.card.variant }] });
      }
      const r = await readAnyCard(this.#deps.database, input.id);
      const printings = printingsOf(r.td);
      // What the full answer pictures the card by before TCGplayer's catalog is asked.
      const product = printings.find((p) => p.tcgplayer?.productId)?.tcgplayer?.productId;
      return ok({ ...detailsOf(r, product), printings: printings.map((p) => ({ label: p.label, variant: p.variant })) });
    } catch (error) {
      const japanese = this.#deps.japanese;
      if (error instanceof JapaneseNotReady && japanese) return err(stillBuilding(japanese.catalog));
      if (error instanceof SourceUnavailable && error.status === 404) return err({ code: 'NO_SUCH_CARD' });
      return err(unavailable(error));
    }
  }
}
