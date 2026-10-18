// Starts the binder server. Configuration comes from the environment (see deploy/README.md).

import path from 'node:path';
import { Accounts } from '../server/accounts.ts';
import { createApp } from './compose.ts';
import { Assets } from '../server/assets.ts';
import { Autofill } from '../server/autofill.ts';
import { Backups } from '../server/backups.ts';
import { Config } from '../server/config.ts';
import { CardDetails } from '../server/details.ts';
import { Guests } from '../server/guests.ts';
import { Logger } from '../server/log.ts';
import { every } from '../server/recover.ts';
import { Catalog } from '../server/pricing/catalog.ts';
import { TcgCsv } from '../server/pricing/tcgcsv.ts';
import { PriceCharting } from '../server/pricing/pricecharting.ts';
import { PriceUpdater } from '../server/pricing/updater.ts';
import { Secret } from '../server/secrets.ts';
import { Security } from '../server/security.ts';
import { Store } from '../server/store.ts';

const env = process.env;
const dataDir = path.resolve(env['DATA_DIR'] ?? 'data');
const port = Number(env['PORT'] ?? 4100);
// Secrets for outside services, kept out of the data directory's backups (a volume of its own in Docker).
const secretsDir = path.resolve(env['SECRETS_DIR'] ?? path.join(dataDir, 'secrets'));
const trust = env['TRUST_PROXY'];

const log = new Logger({ dir: path.join(dataDir, 'logs') });
/** A file the server can't start without is damaged beyond recovery: say so plainly in the log, and stop. */
const orStop = <T>(what: string, make: () => T): T => {
  try {
    return make();
  } catch (err) {
    log.error('app', `Couldn't start: ${what}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
};
const store = orStop('the ledger', () => new Store(dataDir));
if (store.recovered) log.error('app', store.recovered.message, { from: store.recovered.from, keptAs: store.recovered.damaged.setAside });
store.onError = (what: string, err: unknown) => log.error('app', `${what} failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
const assets = new Assets(dataDir);
// PRICE_UPDATE_HOUR and PRICE_UPDATES are the starting schedule; administrators can change it.
const config = new Config(dataDir, { pricing: { enabled: env['PRICE_UPDATES'] !== 'off', hour: Number(env['PRICE_UPDATE_HOUR'] ?? 5) } });
if (config.recovered) log.error('admin', config.recovered);
const backups = new Backups(store, assets, config, log);
store.onDailyCopy = () => backups.prune();

// AUTH=off is only for running on your own computer: no sign-in at all.
const accounts = env['AUTH'] === 'off' ? undefined : orStop('the accounts', () => new Accounts(dataDir, log));
if (accounts) await accounts.bootstrap(env['BINDER_PASSWORD']);
else log.warn('security', 'AUTH=off: sign-in is turned off and anyone who can reach this server can use the ledger.');

// SECURITY_ALLOWLIST: comma-separated IPs or IPv4 ranges never rate limited or blocked.
const security = new Security({ allowlist: (env['SECURITY_ALLOWLIST'] ?? '').split(',').map((s) => s.trim()).filter(Boolean) }, log);
security.start();

// Guests from the QR code (off until an administrator turns guest viewing on).
const guests = new Guests(dataDir, log);
guests.start();

// CARD_LOOKUPS=off: no TCGdex lookups (card details) at all.
const details = env['CARD_LOOKUPS'] === 'off' ? undefined : new CardDetails();
// TCGplayer and Cardmarket prices and pictures from TCGdex.
const catalog = details ? new Catalog() : undefined;
// PriceCharting's API, with the token administrators enter under Administration → Prices.
const pcToken = new Secret(secretsDir, 'pricecharting-token');
// PRICECHARTING_DAILY_LIMIT: most PriceCharting calls a day (2000 by default); the count is kept across restarts.
const pricecharting = new PriceCharting({ token: () => pcToken.read(), log, dailyLimit: Number(env['PRICECHARTING_DAILY_LIMIT']) || undefined, usageFile: path.join(dataDir, 'pricecharting-usage.json') });
// TCGplayer's own catalog from tcgcsv.com (free, no key), for what TCGdex lacks.
const tcgcsv = catalog ? new TcgCsv() : undefined;
const updater = new PriceUpdater({ store, assets, log, config, details, catalog, tcgcsv, pricecharting, timeZone: env['TZ'] || 'America/Vancouver' });
updater.noteToken();
// An update the saved status says is running stopped with the server: say so (a red banner) and let it start again.
updater.recover();
updater.startScheduler();

// A crash is written to the log (and a running price update marked as interrupted, with the error)
// before the server stops; Docker then starts it again.
const crash = (kind: string) => (err: unknown) => {
  try {
    log.error('app', `The server crashed (${kind}): ${err instanceof Error && err.stack ? err.stack : String(err)}`);
    updater.crashed(err);
  } finally {
    process.exit(1);
  }
};
process.on('uncaughtException', crash('uncaught exception'));
process.on('unhandledRejection', crash('unhandled promise rejection'));
// New cards: details, then price and picture, straight away.
const autofill = details ? new Autofill({ store, details, updater, log }) : undefined;
autofill?.start();

const app = createApp({
  store,
  assets,
  accounts,
  security,
  updater,
  log,
  config,
  backups,
  details,
  tcgcsv,
  autofill,
  guests,
  pricecharting: { token: pcToken, api: pricecharting },
  envPassword: env['BINDER_PASSWORD'],
  trustProxy: trust === undefined ? undefined : /^\d+$/.test(trust) ? Number(trust) : trust === 'true',
});

// Housekeeping: today's copy of the ledger, and old trashed photos no copy of it refers to.
const housekeeping = () => {
  try {
    backups.ensureDaily();
    const purged = assets.purgeTrash(Date.now(), () => backups.referencedImages());
    if (purged) log.info('backup', `Deleted ${purged} trashed photo${purged === 1 ? '' : 's'} that no kept copy of the ledger refers to`);
  } catch (err) {
    log.error('backup', `Housekeeping failed: ${err instanceof Error ? err.message : err}`);
  }
};
housekeeping();
every(log, 'backup', 'Housekeeping', 60 * 60_000, housekeeping);
// status.txt for the server's nightly job (Boards' deploy/ops), which alerts on it. Every five
// minutes, so the job sees its own off-site copy reflected soon after making it.
const writeStatus = () => app.writeStatusFile().catch((err) => log.error('app', `Couldn't write the status file: ${err instanceof Error ? err.message : err}`));
void writeStatus();
every(log, 'app', 'Writing the status file', 5 * 60_000, writeStatus);
// Save sessions' last-seen times once a minute rather than on every request.
every(log, 'auth', 'Saving sessions', 60_000, () => accounts?.flush());

const server = app.listen(port, () => {
  const n = store.all();
  log.info('app', `Binder ledger on port ${port}: ${n.binders.length} binders, ${n.cards.length} cards, data in ${dataDir}`);
});
// Drop clients that send requests too slowly (slowloris) or hold idle connections open.
server.headersTimeout = 15_000;
server.requestTimeout = 120_000; // a whole request, including a large restore upload
server.keepAliveTimeout = 30_000;
server.maxHeadersCount = 100;

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    updater.stopScheduler();
    updater.shutdown(`The server was stopped (${sig}: a restart or an update)`);
    autofill?.stop();
    security.stop();
    guests.stop();
    accounts?.flush();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
