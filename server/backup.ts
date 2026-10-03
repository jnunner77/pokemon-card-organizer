import fs from 'node:fs';
import { z } from 'zod';
import { Assets, assetIdSchema } from './assets';
import { COLLECTIONS, type Doc, idSchema, validateDoc } from './schema';
import type { Data, Store } from './store';

// A full backup is one JSON file: every binder, card and setting, plus every stored photo
// as base64. It is what "Download full backup" saves and what "Restore from backup" and
// `npm run import-backup` read, so a ledger can move between servers without losing
// anything. Photos keep their ids, so cards keep pointing at them.

export const BACKUP_FORMAT = 'pokemon-binder-ledger-backup';
export const BACKUP_VERSION = 1;

const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT, { message: "That file isn't a Pokémon Binder Ledger backup" }),
  version: z.number().int().max(BACKUP_VERSION, 'That backup was made by a newer version of this app'),
  exportedAt: z.string().optional(),
  binders: z.record(idSchema, z.record(z.string(), z.unknown())),
  cards: z.record(idSchema, z.record(z.string(), z.unknown())),
  settings: z.record(idSchema, z.record(z.string(), z.unknown())),
  assets: z.record(z.string().regex(assetIdSchema, 'Photo ids are 32 hex characters'), z.object({ type: z.string(), data: z.string() })).default({}),
});
export type Backup = z.input<typeof backupSchema>;

export function makeBackup(store: Store, assets: Assets): Backup {
  const data = store.raw();
  const photos: Backup['assets'] = {};
  for (const id of assets.list()) {
    const hit = assets.find(id);
    if (hit) photos[id] = { type: hit.type, data: fs.readFileSync(hit.file).toString('base64') };
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), ...data, assets: photos };
}

export interface RestoreSummary {
  binders: number;
  cards: number;
  photos: number;
  /** Cards whose photo id isn't in the backup (they show "No photo"). */
  missingPhotos: number;
}

/**
 * Replace the ledger with a backup. Everything is checked before anything is written, and
 * the current db.json is copied to backups/ first. Photos already on this server are kept.
 */
export function restoreBackup(store: Store, assets: Assets, input: unknown): RestoreSummary {
  const r = backupSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new RestoreError(issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message);
  }
  const b = r.data;
  const data = { binders: {}, cards: {}, settings: {} } as Data;
  for (const c of COLLECTIONS) {
    for (const [id, doc] of Object.entries(b[c])) {
      try {
        data[c][id] = validateDoc(c, doc as Doc);
      } catch (err) {
        throw new RestoreError(`${c}.${id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  const photos = Object.entries(b.assets).map(([id, a]) => ({ id, buf: Buffer.from(a.data, 'base64') }));
  for (const p of photos) if (!p.buf.length) throw new RestoreError(`assets.${p.id}: the photo is empty`);
  let written = 0;
  for (const p of photos) {
    if (!assets.put(p.buf, p.id)) throw new RestoreError(`assets.${p.id}: that isn't a JPG, PNG, WebP or GIF picture`);
    written++;
  }
  store.replaceAll(data);
  const missing = Object.values(data.cards).filter((c) => typeof c.imageId === 'string' && !c.imageId.startsWith('data:') && !assets.find(c.imageId)).length;
  return { binders: Object.keys(data.binders).length, cards: Object.keys(data.cards).length, photos: written, missingPhotos: missing };
}

export class RestoreError extends Error {}
