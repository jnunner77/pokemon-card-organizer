import { cardImage, printingsOf } from '#domain/catalog/any-card.ts';
import { isoDate } from '#domain/catalog/names.ts';
import { mapRarity } from '#domain/catalog/rarity.ts';
import { isCardDatabaseId, isSubSet, officialCount, setCodeOf, thumbOf } from '#domain/catalog/tcgdex.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, unavailable } from './errors.ts';
import { type LookupPrinting, SourceUnavailable } from './ports.ts';

/** One card from the card database, with its printings and each one's prices today. */
export interface LookupCard {
  readonly id: string;
  readonly name: string;
  readonly number: string;
  readonly total: number | null;
  readonly set: string;
  readonly setCode: string | null;
  readonly rarity: string | null;
  readonly artist: string | null;
  readonly released: string | null;
  readonly image: string | null;
  readonly thumb: string | null;
  readonly printings: readonly LookupPrinting[];
  /** CAD per US dollar and per euro. */
  readonly rates: { readonly usd: number; readonly eur: number | null };
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
      const td = await db.card(input.id);
      const info = await db.set(td.set.id).catch(() => null);
      const setCode = setCodeOf(info);
      const total = officialCount(td.set);
      // A reprint sub-set's card (30th Classic Collection) is PriceCharting's under the set it belongs to (30th Celebration).
      const parent = (await db.sets().catch(() => [])).find((x) => isSubSet(x.id, td.set.id)) ?? null;
      const priced = await this.#deps.anyCardPricing.price({ card: td, setCode, total, parentSet: parent?.name ?? null, printings: printingsOf(td) });
      // The regular printing's TCGplayer picture is the largest; TCGdex's own otherwise.
      const product = priced.printings.find((p) => p.product)?.product;
      return ok({
        id: td.id,
        name: td.name,
        number: td.localId,
        total,
        set: td.set.name,
        setCode,
        rarity: mapRarity(td.rarity),
        artist: td.illustrator?.trim() || null,
        released: isoDate(info?.releaseDate),
        image: cardImage(td, product),
        thumb: thumbOf(td),
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
