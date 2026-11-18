import type { DetailsMatch, DetailsOption, Filing, SetHints } from '#domain/catalog/details.ts';

/**
 * Finding a card in a card catalog by what the person typed, for looking a card up and filling
 * one in: TCGdex's English catalog (CardMatcher) or TCGplayer's Japanese one (JapaneseCardFinder).
 * The catalog's failures are thrown (SourceUnavailable).
 */
export interface CardFinder {
  /** The cards with this name and number. Several mean the person should choose. */
  lookup(name: string, number: string, hints?: SetHints): Promise<readonly DetailsMatch[]>;
  /** One card by its id, with its set's code and release date. */
  match(id: string): Promise<DetailsMatch>;
  /** A match checked against the set the card is filed under. */
  filing(m: DetailsMatch, filedUnder: unknown): Promise<Filing>;
  /** Cards with this number whose names are close to the one typed (a misspelling). */
  suggest(name: string, number: string, hints?: SetHints): Promise<DetailsOption[]>;
}
