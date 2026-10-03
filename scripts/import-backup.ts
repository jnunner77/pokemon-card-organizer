// Restore a full backup straight into the data directory, without a browser:
//   npm run import-backup -- path/to/binder-ledger-backup.json
// Stop the app first: it keeps the ledger in memory and would write over the restore.
// With Docker (backup copied into the data volume first):
//   docker compose stop binder
//   docker compose run --rm binder npx tsx scripts/import-backup.ts /data/backup.json
//   docker compose start binder
// The current ledger is copied to <data>/backups first. The browser "Restore from backup"
// button does the same thing on a running app, with no restart.
import fs from 'node:fs';
import path from 'node:path';
import { Assets } from '../server/assets';
import { restoreBackup } from '../server/backup';
import { Store } from '../server/store';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import-backup -- <backup.json>');
  process.exit(1);
}
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const input = JSON.parse(fs.readFileSync(file, 'utf8'));
const summary = restoreBackup(new Store(dataDir), new Assets(dataDir), input);
console.log(`Restored ${summary.binders} binders, ${summary.cards} cards and ${summary.photos} photos into ${dataDir}.`);
if (summary.missingPhotos) console.warn(`${summary.missingPhotos} cards point at photos that weren't in the backup.`);
