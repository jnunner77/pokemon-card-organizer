// Deleted photos go to a trash and stay there for at least TRASH_DAYS (longer than the oldest
// monthly copy of the ledger with the default retention), and after that for as long as the
// ledger or any kept copy of it still refers to them, so restoring a copy brings them back.

export const TRASH_DAYS = 400;
const DAY_MS = 86_400_000;

export interface TrashedPhoto {
  /** The photo's id. */
  readonly id: string;
  /** Its file in the trash (an id may have been trashed under several types over time). */
  readonly name: string;
  readonly trashedAt: Date;
}

/** The trashed photos that may be deleted for good now: old enough, and nothing refers to them. */
export function purgeable(trashed: readonly TrashedPhoto[], now: Date, referenced: ReadonlySet<string>): TrashedPhoto[] {
  return trashed.filter((p) => now.getTime() - p.trashedAt.getTime() > TRASH_DAYS * DAY_MS && !referenced.has(p.id));
}

/** Whether any trashed photo is old enough to be deleted, before asking what still refers to them. */
export const anyOldEnough = (trashed: readonly TrashedPhoto[], now: Date): boolean => trashed.some((p) => now.getTime() - p.trashedAt.getTime() > TRASH_DAYS * DAY_MS);
