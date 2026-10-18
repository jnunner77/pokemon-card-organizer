import type { CardRecord } from '#domain/guests/guest-card.ts';
import type { GuestBook, GuestSession } from '#domain/guests/visits.ts';
import type { Result } from '#shared/result.ts';

/** The guest viewing settings and log (guests.json), and the guests signed in now (memory only). */
export interface GuestState {
  book: GuestBook;
  sessions: readonly GuestSession[];
  /** Set when the book changed and must be saved. */
  bookChanged: boolean;
}

export interface GuestDesk {
  /** A copy of the state as it is now. */
  read(): Promise<{ readonly book: GuestBook; readonly sessions: readonly GuestSession[] }>;
  /**
   * Run `work` on the state as one change: kept when it returns ok (the book saved if it says it
   * changed), discarded when it returns an error.
   */
  change<T, E>(work: (state: GuestState) => Result<T, E>): Promise<Result<T, E>>;
}

/** One card of the ledger by its id, for guests' pictures. */
export interface CardLookup {
  card(id: string): Promise<CardRecord | undefined>;
}

/** The page's condition adjustment (public/condition.js), so guests see the value the ledger shows. */
export interface ConditionRules {
  adjust(card: CardRecord, price: Readonly<Record<string, unknown>>): number | null;
}

/** The guest link's QR code, as an SVG picture. */
export interface QrCodes {
  svg(text: string): Promise<string>;
}

/** A change to the ledger: one document of a collection, or the whole ledger replaced (null). */
export interface LedgerChange {
  readonly collection: string | null;
}

/** Changes to the ledger as they're saved, for pages that update live. */
export interface LedgerChanges {
  /** Call `listener` with each change; returns the function that stops it. */
  subscribe(listener: (change: LedgerChange) => void): () => void;
}
