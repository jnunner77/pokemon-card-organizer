import { printingsOf } from '#domain/catalog/any-card.ts';
import { japanesePrintings } from '#domain/catalog/japanese.ts';
import { isCardDatabaseId } from '#domain/catalog/tcgdex.ts';
import { tcgplayerUrl } from '#domain/catalog/tcgplayer.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, JapaneseNotReady, type JapaneseUnavailable, stillBuilding, unavailable } from './errors.ts';
import { type LookupPrinting, SourceUnavailable } from './ports.ts';
import { type AnyCardDetails, detailsOf, readAnyCard } from './read-any-card.ts';
import { readJapaneseCard } from './read-japanese-card.ts';

/** One card from the card database, with its printings and each one's prices today. */
export interface LookupCard extends Omit<AnyCardDetails, 'printings'> {
  readonly printings: readonly LookupPrinting[];
  /** CAD per US dollar and per euro. */
  readonly rates: { readonly usd: number };
  /** What couldn't be had: a source that didn't answer, or has no match. */
  readonly notes: readonly string[];
}

export type ShowAnyCardError = { readonly code: 'NO_SUCH_CARD' } | CardDatabaseUnavailable | JapaneseUnavailable;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Find a card → Any card: one card's details, its printings and each one's prices today, worked
 * out the way the daily update would price it. Nothing is saved: the ledger isn't touched.
 */
export class ShowAnyCard {
  readonly #deps: Pick<CatalogDeps, 'database' | 'japanese' | 'anyCardPricing'>;

  constructor(deps: Pick<CatalogDeps, 'database' | 'japanese' | 'anyCardPricing'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly id: string; readonly language: 'en' | 'ja' }): Promise<Result<LookupCard, ShowAnyCardError>> {
    if (!isCardDatabaseId(input.id)) return err({ code: 'NO_SUCH_CARD' });
    const db = this.#deps.database;
    try {
      if (input.language === 'ja') return await this.#japanese(input.id);
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
      return err(this.#failure(error));
    }
  }

  #failure(error: unknown): ShowAnyCardError {
    const japanese = this.#deps.japanese;
    if (error instanceof JapaneseNotReady && japanese) return stillBuilding(japanese.catalog);
    if (error instanceof SourceUnavailable && error.status === 404) return { code: 'NO_SUCH_CARD' };
    return unavailable(error);
  }

  /** A Japanese card: priced from TCGplayer's Japanese catalog only (PriceCharting isn't asked). */
  async #japanese(id: string): Promise<Result<LookupCard, ShowAnyCardError>> {
    const japanese = this.#deps.japanese;
    if (!japanese) return err({ code: 'JAPANESE_LOOKUPS_OFF' });
    const { entry, details } = await readJapaneseCard(japanese, id);
    const contents = await japanese.tcgplayer.group(entry.set.groupId).catch(() => null);
    const rates = this.#deps.anyCardPricing.rates();
    const printings = japanesePrintings(contents?.prices ?? [], entry.card.productId, entry.card.variant).map((p): LookupPrinting => ({
      label: p.label,
      variant: p.variant,
      tcgplayer: p.usd != null ? { usd: p.usd, url: tcgplayerUrl(entry.card.productId) } : null,
      pricecharting: null,
      leftOut: null,
      price: p.usd != null ? { usd: p.usd, cad: round2(p.usd * rates.usd), where: 'TCGplayer', summary: 'TCGplayer market price (Japanese)' } : null,
    }));
    const notes = ["Japanese cards are priced from TCGplayer's Japanese catalog only here; PriceCharting isn't asked."];
    if (!contents) notes.push("TCGplayer's Japanese catalog (tcgcsv.com) didn't answer.");
    return ok({ ...details, printings, rates, notes });
  }
}
