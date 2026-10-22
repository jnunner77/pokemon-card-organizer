import { isoDate } from './names.ts';

// What TCGdex (https://tcgdex.dev), a free, open database of Pokémon cards, says about cards and
// sets, as the binder reads it.

type TcgplayerEntry = { readonly productId?: number | undefined; readonly marketPrice?: number | null | undefined };

/** A card's (or one of its variants') prices: TCGplayer's by printing, and Cardmarket's (in euros). */
export interface TcgdexPricing {
  readonly tcgplayer?: Readonly<Record<string, TcgplayerEntry | string>> | null | undefined;
  readonly cardmarket?: Readonly<Record<string, number | string | null>> | null | undefined;
}

/** One of a TCGdex card's variants: its kind, pattern (foil), stamps and subtype, with its own products and prices. */
export interface TcgdexVariant {
  readonly type: string;
  readonly subtype?: string | undefined;
  readonly foil?: string | undefined;
  readonly stamp?: readonly string[] | undefined;
  /** Standard-size or jumbo. */
  readonly size?: string | undefined;
  readonly thirdParty?: { readonly tcgplayer?: number | undefined; readonly cardmarket?: number | undefined } | undefined;
  readonly pricing?: TcgdexPricing | null | undefined;
}

/** A set as a card names it. */
export interface TcgdexCardSet {
  readonly id: string;
  readonly name: string;
  readonly cardCount?: { readonly official?: number | undefined } | undefined;
}

/** A card as a search lists it. */
export interface TcgdexBrief {
  /** "sv05-051". */
  readonly id: string;
  /** The number on the card, as TCGdex writes it ("051"). */
  readonly localId: string;
  readonly name: string;
  readonly image?: string | undefined;
}

/** One card in full. */
export interface TcgdexCard extends TcgdexBrief {
  readonly set: TcgdexCardSet;
  readonly category?: string | undefined;
  readonly rarity?: string | undefined;
  readonly illustrator?: string | undefined;
  readonly pricing?: TcgdexPricing | null | undefined;
  readonly variants?: { readonly normal?: boolean | undefined; readonly reverse?: boolean | undefined; readonly holo?: boolean | undefined; readonly firstEdition?: boolean | undefined } | null | undefined;
  readonly variants_detailed?: readonly TcgdexVariant[] | null | undefined;
}

/** A set as the list of sets gives it. */
export interface TcgdexSetBrief {
  readonly id: string;
  readonly name: string;
  readonly cardCount?: { readonly official?: number | undefined; readonly total?: number | undefined } | undefined;
}

/** One set in full: its codes, release date and cards. */
export interface TcgdexSet extends TcgdexSetBrief {
  readonly abbreviation?: { readonly official?: string | undefined } | undefined;
  readonly tcgOnline?: string | undefined;
  readonly releaseDate?: string | undefined;
  readonly cards?: readonly TcgdexBrief[] | undefined;
}

/** A card id's set: "30th-c-029" → "30th-c", "A4-149" → "A4". */
export const setOfCard = (c: TcgdexBrief): string => (c.id.endsWith(`-${c.localId}`) ? c.id.slice(0, -c.localId.length - 1) : c.id.replace(/-[^-]+$/, ''));

/**
 * A TCGdex reprint sub-set of a set: its id plus a short suffix ("30th-c" 30th Classic Collection,
 * "cel25c" Celebrations Classic Collection, "swsh9tg" Trainer Gallery, "swsh12.5gg" Galarian
 * Gallery). Their cards keep the printed number of the card they reprint, so a number alone
 * finds the original (Aquapolis Lugia 149/147 for the 30th Celebration one).
 */
export const isSubSet = (base: string, id: string): boolean => id !== base && id.startsWith(base) && /^-?[a-z]{1,3}$/.test(id.slice(base.length));

/** TCG Pocket's sets (TCGdex series tcgp): digital-only cards, never a card in a binder. */
const POCKET_ID = /^(?:[AB]\d+[a-z]?|P-[AB])$/;

/** Whether a set is TCG Pocket's: in TCGdex's series tcgp, or shaped like its ids when TCGdex doesn't say. */
export const isPocketSet = (setId: string, pocketIds: ReadonlySet<string>): boolean => pocketIds.has(setId) || POCKET_ID.test(setId);

/** A set's official code ("TEF"), or TCG Live's when it has none. */
export const setCodeOf = (s: TcgdexSet | null | undefined): string | null => s?.abbreviation?.official ?? s?.tcgOnline ?? null;

/** When a set came out, YYYY-MM-DD. */
export const releasedOf = (s: TcgdexSet | null | undefined): string | null => isoDate(s?.releaseDate);

/** Small picture for choosing between cards. */
export const thumbOf = (c: TcgdexBrief): string | null => (c.image ? `${c.image}/low.webp` : null);

/** How many cards the set officially has (the "/162"); null for promos. */
export const officialCount = (s: TcgdexCardSet | TcgdexSetBrief): number | null => s.cardCount?.official || null;

/** A TCGdex card id as the API takes it ("base1-4", "sv03.5-006", "swshp-SWSH050"). */
export const isCardDatabaseId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id);
