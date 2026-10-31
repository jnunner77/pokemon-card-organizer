import { cardImage } from '#domain/catalog/any-card.ts';
import { isoDate } from '#domain/catalog/names.ts';
import { mapRarity } from '#domain/catalog/rarity.ts';
import { isSubSet, officialCount, setCodeOf, thumbOf, type TcgdexCard, type TcgdexSet, type TcgdexSetBrief } from '#domain/catalog/tcgdex.ts';
import type { CardDatabase } from './ports.ts';

/** What the card database says about one card and its set. */
export interface AnyCardRead {
  readonly td: TcgdexCard;
  readonly info: TcgdexSet | null;
  readonly setCode: string | null;
  readonly total: number | null;
  /** The set a reprint sub-set's card belongs to, for PriceCharting. */
  readonly parentSet: string | null;
}

/** One card's details, as the page shows them before its prices. */
export interface AnyCardDetails {
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
  /** In words ("Master Ball reverse") and what to type in a card's Variant ("" for the regular card). */
  readonly printings: readonly { readonly label: string; readonly variant: string }[];
}

/**
 * Reads a card and its set from the card database. The set list is asked for before the card, and
 * the card's set once the card is known, so the requests overlap (the adapter shares requests for
 * the same path). Throws whatever the card's request throws; callers catch.
 */
export async function readAnyCard(db: CardDatabase, id: string): Promise<AnyCardRead> {
  const setsAsked = db.sets().catch((): readonly TcgdexSetBrief[] => []);
  const td = await db.card(id);
  const [info, sets] = await Promise.all([db.set(td.set.id).catch(() => null), setsAsked]);
  // A reprint sub-set's card (30th Classic Collection) is PriceCharting's under the set it belongs to (30th Celebration).
  const parentSet = sets.find((x) => isSubSet(x.id, td.set.id))?.name ?? null;
  return { td, info, setCode: setCodeOf(info), total: officialCount(td.set), parentSet };
}

/** The card's details, its picture being its TCGplayer product's when the card database has none. */
export function detailsOf(r: AnyCardRead, product: string | null | undefined): Omit<AnyCardDetails, 'printings'> {
  const { td, info } = r;
  return {
    id: td.id,
    name: td.name,
    number: td.localId,
    total: r.total,
    set: td.set.name,
    setCode: r.setCode,
    rarity: mapRarity(td.rarity),
    artist: td.illustrator?.trim() || null,
    released: isoDate(info?.releaseDate),
    image: cardImage(td, product),
    thumb: thumbOf(td),
  };
}
