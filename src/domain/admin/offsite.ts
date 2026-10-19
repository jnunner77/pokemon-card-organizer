import { isIsoDateTime, isRecord } from './input.ts';

// The server's nightly job (Boards' deploy/ops) writes offsite.json in the data directory after
// copying a backup off the server: when, and where to.

export interface OffsiteCopy {
  readonly at: string;
  readonly where: string;
}

/** The nightly job's record, or null when it isn't one. */
export function offsiteCopyFrom(raw: unknown): OffsiteCopy | null {
  if (!isRecord(raw)) return null;
  const { at, where } = raw;
  if (typeof at !== 'string' || !isIsoDateTime(at) || typeof where !== 'string' || where.length < 1 || where.length > 300) return null;
  return { at, where };
}
