import type { JapaneseCatalog } from './japanese-catalog.ts';
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

/** Japanese lookups can't be answered: they're off on this server, or the index is still being built for the first time. */
export type JapaneseUnavailable = { readonly code: 'JAPANESE_LOOKUPS_OFF' } | { readonly code: 'JAPANESE_CATALOG_NOT_READY'; readonly done: number; readonly total: number };

/** The first build's progress, as a Result error. */
export const stillBuilding = (c: JapaneseCatalog): JapaneseUnavailable => ({ code: 'JAPANESE_CATALOG_NOT_READY', done: c.progress.done, total: c.progress.total });

/** The catalog isn't ready for lookups yet, as a Result error; null when it is. */
export function notReady(c: JapaneseCatalog): JapaneseUnavailable | null {
  return c.readiness().ready ? null : stillBuilding(c);
}

/** Thrown inside the Japanese finder when the index hasn't finished its first build. */
export class JapaneseNotReady extends Error {}
