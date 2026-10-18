import type { Retention } from './retention.ts';
import { retain } from './retention.ts';

// Copies of the ledger kept on the server:
//
// - daily:          db-YYYY-MM-DD.json, taken once a day (and before the first change of a day),
//                   kept with tiered retention (retention.ts).
// - snapshot:       db-snapshot-<time>[-label].json, taken by an administrator; the newest 50 kept.
// - before-restore: db-before-restore-<time>.json, taken before any restore; the newest 10 kept.
//
// Photos aren't copied: they never change once stored, and deleted ones stay in the photo trash
// while any kept copy refers to them (photos/trash.ts), so restoring a copy brings them back.

export const COPY_KINDS = ['daily', 'snapshot', 'before-restore'] as const;
export type CopyKind = (typeof COPY_KINDS)[number];

export const COPY_NAME = /^db-(\d{4}-\d{2}-\d{2}|snapshot-[\w-]+|before-restore-[\w-]+)\.json$/;
export const isCopyName = (name: string): boolean => COPY_NAME.test(name);

export const MAX_SNAPSHOTS = 50;
export const MAX_BEFORE_RESTORE = 10;
const MAX_LABEL = 40;

export interface KeptCopy {
  readonly name: string;
  readonly kind: CopyKind;
  /** When the copy was taken (from the name for daily copies), ISO. */
  readonly at: string;
  readonly bytes: number;
  readonly label?: string;
}

/** A copy's details from its file name, last change and size; null for a file that isn't a copy. */
export function describeCopy(name: string, modifiedAt: Date, bytes: number): KeptCopy | null {
  if (!isCopyName(name)) return null;
  const kind: CopyKind = name.startsWith('db-snapshot-') ? 'snapshot' : name.startsWith('db-before-restore-') ? 'before-restore' : 'daily';
  const label =
    kind === 'snapshot'
      ? name
          .replace(/^db-snapshot-[\dT-]+Z?-?/, '')
          .replace(/\.json$/, '')
          .replace(/-/g, ' ')
      : '';
  return { name, kind, at: kind === 'daily' ? `${name.slice(3, 13)}T00:00:00.000Z` : modifiedAt.toISOString(), bytes, ...(label ? { label } : {}) };
}

/** Newest first. */
export const newestFirst = (copies: readonly KeptCopy[]): KeptCopy[] => [...copies].sort((a, b) => b.at.localeCompare(a.at));

const stamp = (at: Date) => at.toISOString().replace(/[:.]/g, '-');

export const dailyCopyName = (day: string): string => `db-${day}.json`;
export const beforeRestoreName = (at: Date): string => `db-before-restore-${stamp(at)}.json`;

/** A snapshot's name: when it was taken, and its label made safe for a file name. */
export function snapshotName(at: Date, label: string | undefined): string {
  const clean = (label ?? '')
    .slice(0, MAX_LABEL)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_LABEL);
  return `db-snapshot-${stamp(at)}${clean ? `-${clean}` : ''}.json`;
}

/** The copies retention no longer keeps: daily copies past it, and snapshots and before-restore copies past their counts. */
export function copiesToDrop(copies: readonly KeptCopy[], r: Retention): KeptCopy[] {
  const sorted = newestFirst(copies);
  const day = (c: KeptCopy) => c.name.slice(3, 13);
  const keepDays = retain(
    sorted.filter((c) => c.kind === 'daily').map(day),
    r,
  );
  return [
    ...sorted.filter((c) => c.kind === 'daily' && !keepDays.has(day(c))),
    ...sorted.filter((c) => c.kind === 'snapshot').slice(MAX_SNAPSHOTS),
    ...sorted.filter((c) => c.kind === 'before-restore').slice(MAX_BEFORE_RESTORE),
  ];
}
