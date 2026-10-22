// Prices and pictures from the TCGdex card database's API, with nothing scraped:
//
// - TCGdex (https://tcgdex.dev, free, no key), which the binder already matches every card to for
//   its details (src/application/catalog). Each card lists its variants (regular, reverse, holo, patterns such
//   as Poké Ball and Master Ball, stamps, 1st Edition, Shadowless), each with its own TCGplayer
//   and Cardmarket products and prices (in euros), refreshed daily. A card is priced from the
//   variant its Variant field names, never from another variant's price. Its TCGplayer product's
//   picture (717×1000), then TCGdex's own (600×825), picture the card.
//
// TCGplayer's own catalog (tcgcsv.ts) fills what TCGdex lacks. The updater (updater.ts) blends
// these with PriceCharting's price.

import { chooseVariant, featuresOf, printingOf, tcgdexCardmarket, tcgdexTcgplayer, variantLabel, variantPrices } from '#domain/catalog/printings.ts';
import type { TcgdexCard } from '#domain/catalog/tcgdex.ts';
import { type Fetcher, SourceError, get } from './sources.ts';

// Reading a TCGdex card's printings and their prices is the domain's (src/domain/catalog/printings.ts).
export { chooseVariant, featuresOf, namesFeature, pickPrinting, type Printing, printingOf, tcgdexCardmarket, tcgdexTcgplayer, variantLabel, variantPrices } from '#domain/catalog/printings.ts';
export type { TcgdexCard, TcgdexVariant } from '#domain/catalog/tcgdex.ts';

const TCGDEX = 'https://api.tcgdex.net/v2/en';

// ---- one card -----------------------------------------------------------------------

/** What TCGdex says about one card today. */
export interface CatalogQuote {
  tcgdexId: string;
  /** TCGplayer's market price in US$ for the card's printing, and its TCGplayer product. */
  tcgplayer: { usd: number; productId: string | null } | null;
  /** Cardmarket's trend price in euros for the card's printing. */
  cardmarketEur: number | null;
  /** The TCGplayer product of the card's printing, even on a day TCGplayer has no price for it (its picture stands in, updater.ts). */
  tcgplayerProduct: string | null;
  /** TCGdex's own picture (600×825), the last to try for a card with none. */
  fallbackImage: string | null;
  /** The card's Variant names more than a plain printing (a pattern, stamp, edition…). */
  special: boolean;
  /** No TCGdex variant fits the card's Variant: TCGdex's prices aren't used for it. */
  unknownVariant: boolean;
  /** The TCGdex variant priced, in words (for a special one). */
  variant: string | null;
  /** TCGplayer products of the card's plain printings: an automatic link to one of these is wrong for a special variant. */
  plainProducts: string[];
  /** The card's name and set as TCGdex has them, for naming a TCGplayer product found this way. */
  name: string;
  set: string;
  number: string;
}

export interface CatalogOptions {
  fetcher?: Fetcher;
}

/** TCGdex isn't asked again until reset() once it kept failing. */
class Skipped extends SourceError {}

/** Asks TCGdex about cards. If it keeps failing it's left alone until reset(). */
export class Catalog {
  private readonly fetcher: Fetcher;
  private streak = 0;
  static readonly breakerAfter = 3;

  constructor(o: CatalogOptions = {}) {
    this.fetcher = o.fetcher ?? fetch;
  }

  /** Start of a price update: ask TCGdex again. */
  reset() {
    this.streak = 0;
  }

  private async json<T>(url: string): Promise<T> {
    if (this.streak >= Catalog.breakerAfter) throw new Skipped('Skipped: TCGdex kept failing during this update.');
    try {
      const out = (await (await get(this.fetcher, url, { headers: { Accept: 'application/json' } })).json()) as T;
      this.streak = 0;
      return out;
    } catch (err) {
      this.streak++;
      throw err;
    }
  }

  /** Today's prices and picture for the TCGdex card `tcgdexId`, priced as the card's own variant. */
  async quote(tcgdexId: string, card: { variant?: unknown; rarity?: unknown }): Promise<CatalogQuote> {
    const td = await this.json<TcgdexCard>(`${TCGDEX}/cards/${encodeURIComponent(tcgdexId)}`);
    // The card's own variant's prices; TCGdex's card-wide lists only for a card with no variant list.
    const want = printingOf(card.variant, card.rarity);
    const chosen = chooseVariant(td, card.variant);
    const own = chosen.variant ? variantPrices(chosen.variant) : null;
    const tcgplayer = chosen.unknown ? null : own ? own.tcgplayer : tcgdexTcgplayer(td, want);
    const cardmarketEur = chosen.unknown ? null : own ? own.cardmarketEur : tcgdexCardmarket(td, want);
    const plainProducts = [
      ...(td.variants_detailed ?? []).filter((v) => !featuresOf(v).length).map((v) => v.thirdParty?.tcgplayer),
      ...Object.values(td.pricing?.tcgplayer ?? {}).map((v) => (typeof v === 'object' && v ? v.productId : undefined)),
    ]
      .filter((n): n is number => typeof n === 'number')
      .map((n) => String(Math.trunc(n)));
    return {
      tcgdexId,
      tcgplayer,
      cardmarketEur,
      tcgplayerProduct: chosen.unknown ? null : (tcgplayer?.productId ?? (chosen.variant?.thirdParty?.tcgplayer ? String(Math.trunc(chosen.variant.thirdParty.tcgplayer)) : null)),
      fallbackImage: td.image ? `${td.image}/high.png` : null,
      special: chosen.special,
      unknownVariant: chosen.unknown,
      variant: chosen.special && chosen.variant ? variantLabel(chosen.variant) : null,
      plainProducts: [...new Set(plainProducts)],
      name: td.name,
      set: td.set.name,
      number: td.localId,
    };
  }
}
