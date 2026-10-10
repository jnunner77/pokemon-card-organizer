import path from 'node:path';
import { Accounts } from './accounts';
import { createApp } from './app';
import { Assets } from './assets';
import { Autofill } from './autofill';
import { Backups } from './backups';
import { Config } from './config';
import { CardDetails } from './details';
import { Guests } from './guests';
import { Logger } from './log';
import { Catalog } from './pricing/catalog';
import { PriceCharting } from './pricing/pricecharting';
import { PriceUpdater } from './pricing/updater';
import { Secret } from './secrets';
import { Security } from './security';
import { Store } from './store';

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR ?? 'data');
const port = Number(env.PORT ?? 4100);
// Secrets for outside services, kept out of the data directory's backups (a volume of its own in Docker).
const secretsDir = path.resolve(env.SECRETS_DIR ?? path.join(dataDir, 'secrets'));
const trust = env.TRUST_PROXY;

const log = new Logger({ dir: path.join(dataDir, 'logs') });
const store = new Store(dataDir);
const assets = new Assets(dataDir);
// PRICE_UPDATE_HOUR and PRICE_UPDATES are the starting schedule; administrators can change it.
const config = new Config(dataDir, { pricing: { enabled: env.PRICE_UPDATES !== 'off', hour: Number(env.PRICE_UPDATE_HOUR ?? 5) } });
const backups = new Backups(store, assets, config, log);
store.onDailyCopy = () => backups.prune();

// AUTH=off is only for running on your own computer: no sign-in at all.
const accounts = env.AUTH === 'off' ? undefined : new Accounts(dataDir, log);
if (accounts) await accounts.bootstrap(env.BINDER_PASSWORD);
else log.warn('security', 'AUTH=off: sign-in is turned off and anyone who can reach this server can use the ledger.');

// SECURITY_ALLOWLIST: comma-separated IPs or IPv4 ranges never rate limited or blocked.
const security = new Security({ allowlist: (env.SECURITY_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean) }, log);
security.start();

// Guests from the QR code (off until an administrator turns guest viewing on).
const guests = new Guests(dataDir, log);
guests.start();

// CARD_LOOKUPS=off: no TCGdex lookups (card details) at all.
const details = env.CARD_LOOKUPS === 'off' ? undefined : new CardDetails();
// Prices and large pictures from TCGdex and pokemontcg.io (POKEMONTCG_API_KEY optional: raises its limits).
const catalog = details ? new Catalog({ ptcgKey: env.POKEMONTCG_API_KEY }) : undefined;
// PriceCharting's API, with the token administrators enter under Administration → Prices.
const pcToken = new Secret(secretsDir, 'pricecharting-token');
const pricecharting = new PriceCharting({ token: () => pcToken.read() });
const updater = new PriceUpdater({ store, assets, log, config, details, catalog, pricecharting, timeZone: env.TZ || 'America/Vancouver' });
updater.noteToken();
updater.startScheduler();
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
  autofill,
  guests,
  pricecharting: { token: pcToken, api: pricecharting },
  envPassword: env.BINDER_PASSWORD,
  trustProxy: trust === undefined ? undefined : /^\d+$/.test(trust) ? Number(trust) : trust === 'true',
});

// Housekeeping: today's copy of the ledger, and trashed photos older than the oldest backup.
const housekeeping = () => {
  try {
    backups.ensureDaily();
    const purged = assets.purgeTrash();
    if (purged) log.info('backup', `Deleted ${purged} trashed photo${purged === 1 ? '' : 's'} older than the oldest backup`);
  } catch (err) {
    log.error('backup', `Housekeeping failed: ${err instanceof Error ? err.message : err}`);
  }
};
housekeeping();
setInterval(housekeeping, 60 * 60_000).unref();
// status.txt for the server's nightly job (Boards' deploy/ops), which alerts on it. Every five
// minutes, so the job sees its own off-site copy reflected soon after making it.
const writeStatus = () => app.writeStatusFile().catch((err) => log.error('app', `Couldn't write the status file: ${err instanceof Error ? err.message : err}`));
void writeStatus();
setInterval(writeStatus, 5 * 60_000).unref();
// Save sessions' last-seen times once a minute rather than on every request.
setInterval(() => accounts?.flush(), 60_000).unref();

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
    autofill?.stop();
    security.stop();
    guests.stop();
    accounts?.flush();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
