import { SourceUnavailable } from './ports.ts';

/** The card database (TCGdex) didn't answer. */
export type CardDatabaseUnavailable = { readonly code: 'CARD_DATABASE_UNAVAILABLE'; readonly message: string };

/** The card database's failure as a Result error; anything else is thrown on. */
export function unavailable(error: unknown): CardDatabaseUnavailable {
  if (error instanceof SourceUnavailable) return { code: 'CARD_DATABASE_UNAVAILABLE', message: error.message };
  throw error;
}

/** What a failure says, for the log or a card's record. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
