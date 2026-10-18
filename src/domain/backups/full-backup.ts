import { err, ok, type Result } from '#shared/result.ts';
import { checkDocument } from '../ledger/check-document.ts';
import { COLLECTIONS, type Collection, type Fields, isRecord } from '../ledger/document.ts';
import { DOCUMENT_ID, DOCUMENT_ID_RULE } from '../ledger/ids.ts';
import { checkPhoto, PHOTO_ID, type PhotoType } from '../photos/photo.ts';

// A full backup is one JSON file: every binder, card and setting, plus every stored photo as
// base64. It is what "Download full backup" saves and what "Restore from backup" and
// `npm run import-backup` read, so a ledger can move between servers without losing anything.
// Photos keep their ids, so cards keep pointing at them.

export const BACKUP_FORMAT = 'pokemon-binder-ledger-backup';
export const BACKUP_VERSION = 1;

/** The ledger's documents by collection and id. */
export type LedgerData = Readonly<Record<Collection, Readonly<Record<string, Fields>>>>;

/** A photo in a backup: its type and its bytes as base64. */
export interface BackupPhoto {
  readonly type: string;
  readonly data: string;
}

export interface FullBackup {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: number;
  readonly exportedAt: string;
  readonly binders: Readonly<Record<string, Fields>>;
  readonly cards: Readonly<Record<string, Fields>>;
  readonly settings: Readonly<Record<string, Fields>>;
  readonly assets: Readonly<Record<string, BackupPhoto>>;
}

export type InvalidBackup = { readonly code: 'INVALID_BACKUP'; readonly message: string };

const invalid = (message: string) => err<InvalidBackup>({ code: 'INVALID_BACKUP', message });

export function fullBackup(ledger: LedgerData, photos: Readonly<Record<string, BackupPhoto>>, at: Date): FullBackup {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: at.toISOString(), ...ledger, assets: photos };
}

/** A collection of documents: an object of objects under valid ids. */
function documents(value: unknown, where: string): Result<Record<string, Record<string, unknown>>, InvalidBackup> {
  if (!isRecord(value)) return invalid(`${where}: Expected an object`);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, doc] of Object.entries(value)) {
    if (!DOCUMENT_ID.test(id)) return invalid(`${where}.${id}: ${DOCUMENT_ID_RULE}`);
    if (!isRecord(doc)) return invalid(`${where}.${id}: Expected an object`);
    out[id] = doc;
  }
  return ok(out);
}

/**
 * Read a backup someone wants to restore: the right format and version, every document valid by the
 * ledger's rules, every photo entry well formed. The photos' bytes are checked once decoded
 * (checkBackupPhoto). Nothing in it is trusted until this says so.
 */
export function readFullBackup(input: unknown): Result<{ ledger: LedgerData; photos: Readonly<Record<string, BackupPhoto>> }, InvalidBackup> {
  if (!isRecord(input)) return invalid("format: That file isn't a Pokémon Binder Ledger backup");
  if (input['format'] !== BACKUP_FORMAT) return invalid("format: That file isn't a Pokémon Binder Ledger backup");
  const version = input['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) return invalid('version: Expected a whole number');
  if (version > BACKUP_VERSION) return invalid('version: That backup was made by a newer version of this app');
  if (input['exportedAt'] !== undefined && typeof input['exportedAt'] !== 'string') return invalid('exportedAt: Expected text');

  const raw: Partial<Record<Collection, Record<string, Record<string, unknown>>>> = {};
  for (const c of COLLECTIONS) {
    const docs = documents(input[c], c);
    if (!docs.ok) return docs;
    raw[c] = docs.value;
  }
  const photos: Record<string, BackupPhoto> = {};
  const assets = input['assets'] === undefined ? {} : input['assets'];
  if (!isRecord(assets)) return invalid('assets: Expected an object');
  for (const [id, photo] of Object.entries(assets)) {
    if (!PHOTO_ID.test(id)) return invalid(`assets.${id}: Photo ids are 32 hex characters`);
    if (!isRecord(photo)) return invalid(`assets.${id}: Expected an object`);
    const { type, data } = photo;
    if (typeof type !== 'string') return invalid(`assets.${id}.type: Expected text`);
    if (typeof data !== 'string') return invalid(`assets.${id}.data: Expected text`);
    photos[id] = { type, data };
  }

  const ledger: Record<Collection, Record<string, Fields>> = { binders: {}, cards: {}, settings: {} };
  for (const c of COLLECTIONS) {
    for (const [id, doc] of Object.entries(raw[c] ?? {})) {
      const checked = checkDocument(c, doc);
      if (!checked.ok) return invalid(`${c}.${id}: ${checked.error.message}`);
      ledger[c][id] = checked.value;
    }
  }
  return ok({ ledger, photos });
}

/** A backup's photo, once decoded, must have bytes and be a picture. */
export function checkBackupPhoto(id: string, bytes: Uint8Array): Result<PhotoType, InvalidBackup> {
  const r = checkPhoto(bytes);
  if (r.ok) return r;
  return invalid(r.error.code === 'PHOTO_EMPTY' ? `assets.${id}: the photo is empty` : `assets.${id}: that isn't a JPG, PNG, WebP or GIF picture`);
}

/**
 * The documents of a kept copy of the ledger (written by this server), each checked by the ledger's
 * rules. A collection the copy leaves out is empty; a damaged copy (not an object, or a collection
 * that isn't one) is refused, so it never replaces the ledger.
 */
export function readLedgerCopy(input: unknown): Result<LedgerData, { readonly code: 'INVALID_DOCUMENT'; readonly message: string }> {
  const ledger: Record<Collection, Record<string, Fields>> = { binders: {}, cards: {}, settings: {} };
  if (!isRecord(input)) return err({ code: 'INVALID_DOCUMENT', message: "That copy of the ledger isn't a JSON object" });
  for (const c of COLLECTIONS) {
    const docs = input[c];
    if (docs === undefined) continue;
    if (!isRecord(docs)) return err({ code: 'INVALID_DOCUMENT', message: 'A document must be a JSON object' });
    for (const [id, doc] of Object.entries(docs)) {
      const checked = checkDocument(c, doc);
      if (!checked.ok) return checked;
      ledger[c][id] = checked.value;
    }
  }
  return ok(ledger);
}
