import type { CardPrinting } from '#domain/catalog/any-card.ts';
import type { TcgdexBrief, TcgdexCard, TcgdexSet, TcgdexSetBrief } from '#domain/catalog/tcgdex.ts';
import type { TcgGroup, TcgGroupContents } from '#domain/catalog/tcgplayer.ts';
import type { Fields } from '#domain/ledger/document.ts';
import type { ActivityLog } from '../ports.ts';

// What asking the card databases about cards needs from outside: TCGdex and TCGplayer's own
// catalog, the daily price update (which stays outside the layers until its slice moves), the
// cards as they change, and time to wait.

/**
 * An outside source (the card database, TCGplayer's catalog) didn't answer, or answered with an
 * error. The adapters reject with it; the use cases answer with a Result error instead.
 */
export class SourceUnavailable extends Error {
  /** The HTTP status it answered with, when it answered (404: it has no such card or set). */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** TCGdex (https://tcgdex.dev), a free, open database of Pokémon cards. Its answers are remembered for a while. */
export interface CardDatabase {
  /** Cards whose name has these words. */
  cardsNamed(name: string): Promise<readonly TcgdexBrief[]>;
  /** Cards with this number. */
  cardsNumbered(localId: string): Promise<readonly TcgdexBrief[]>;
  /** One card in full. */
  card(id: string): Promise<TcgdexCard>;
  /** One set in full, with its cards. */
  set(id: string): Promise<TcgdexSet>;
  /** Every set, oldest first. */
  sets(): Promise<readonly TcgdexSetBrief[]>;
  /** The sets whose name has these words. */
  setsNamed(name: string): Promise<readonly TcgdexSetBrief[]>;
  /** TCG Pocket's sets (its series tcgp), asked once a day; none when it doesn't answer. */
  pocketSets(): Promise<ReadonlySet<string>>;
}

/** TCGplayer's own catalog (tcgcsv.com): its Pokémon sets and their products, downloaded at most once a day. */
export interface TcgplayerCatalog {
  /** Someone asked now: try it even if a price update found it failing. */
  reset(): void;
  groupList(): Promise<readonly TcgGroup[]>;
  group(groupId: number): Promise<TcgGroupContents>;
}

/** The daily price update, as new cards and chosen matches use it. */
export interface CardPricing {
  /** Automatic prices are on, and no update is running (which would price the card anyway). */
  canPriceNow(): boolean;
  /** Price one card and fetch its picture now; what happened ("updated", "needsMatch"…). */
  updateCard(id: string): Promise<string>;
}

/** One printing of a looked-up card (regular, reverse holo, a Poké Ball pattern, 1st Edition…) and its prices. */
export interface LookupPrinting {
  /** In words: "Master Ball reverse", "regular". */
  readonly label: string;
  /** What to type in a card's Variant for this printing ("" for the regular card). */
  readonly variant: string;
  readonly tcgplayer: { readonly usd: number; readonly url: string | null } | null;
  readonly pricecharting: {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly usd: number | null;
    readonly grades: readonly { readonly label: string; readonly usd: number; readonly cad: number }[];
  } | null;
  /** TCGplayer's price is for another set or printing than PriceCharting's product: why. */
  readonly leftOut: string | null;
  /** What the daily update would log for it today. */
  readonly price: { readonly usd: number; readonly cad: number; readonly where: string; readonly summary: string } | null;
}

/** A card from the card database, to be priced the way the daily update would price it. */
export interface AnyCardToPrice {
  readonly card: TcgdexCard;
  readonly setCode: string | null;
  readonly total: number | null;
  /** The set a reprint sub-set's card belongs to (30th Celebration for 30th Classic Collection). */
  readonly parentSet: string | null;
  readonly printings: readonly CardPrinting[];
}

export interface AnyCardPrices {
  /** Each printing priced, with its TCGplayer product (perhaps found in TCGplayer's own catalog). */
  readonly printings: readonly { readonly printing: LookupPrinting; readonly product: string | null }[];
  /** CAD per US dollar and per euro. */
  readonly rates: { readonly usd: number };
  /** What couldn't be had: a source that didn't answer, or has no match. */
  readonly notes: readonly string[];
}

/** Today's prices for a card that isn't in the ledger, worked out as the daily update would. Nothing is saved. */
export interface AnyCardPricing {
  price(card: AnyCardToPrice): Promise<AnyCardPrices>;
  /** Fetch now what price() will need from TCGplayer's catalog for this card (never PriceCharting), so pricing it soon after is quicker; resolves, never rejects. */
  warm(card: AnyCardToPrice): Promise<void>;
}

/** A card saved or deleted (null), or the whole ledger replaced (a restore). */
export type CardChange = { readonly kind: 'card'; readonly id: string; readonly card: Fields | null } | { readonly kind: 'replaced' };

/** The ledger's cards as they change. */
export interface CardChanges {
  /** Every card as it is now. */
  current(): readonly { readonly id: string; readonly card: Fields }[];
  /** Call `listener` with each change as it's saved; returns the function that stops it. */
  subscribe(listener: (change: CardChange) => void): () => void;
}

/** Waiting, for work done in the background one card at a time. */
export interface Scheduler {
  /** Resolves after `ms`. */
  pause(ms: number): Promise<void>;
  /** Run `job` once after `ms`, without keeping the server running; returns the function that cancels it. */
  after(ms: number, job: () => void): () => void;
}

/** The log of work done in the background, which can also fail. */
export interface JobLog extends ActivityLog {
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}
