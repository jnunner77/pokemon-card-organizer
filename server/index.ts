import path from 'node:path';
import { Assets } from './assets';
import { createApp } from './app';
import { Auth } from './auth';
import { PriceUpdater } from './pricing/updater';
import { Store } from './store';

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const port = Number(process.env.PORT ?? 4100);
const trust = process.env.TRUST_PROXY;

const store = new Store(dataDir);
const assets = new Assets(dataDir);
const auth = new Auth(dataDir);
if (!auth.enabled) console.warn('BINDER_PASSWORD is not set: anyone who can reach this server can use the ledger.');

// Daily prices and images. PRICE_UPDATES=off turns them off; TZ and PRICE_UPDATE_HOUR set when.
const updater =
  process.env.PRICE_UPDATES === 'off'
    ? undefined
    : new PriceUpdater({ store, assets, timeZone: process.env.TZ || 'America/Vancouver', hour: Number(process.env.PRICE_UPDATE_HOUR ?? 5) });
updater?.startScheduler();

const app = createApp({ store, assets, auth, updater, trustProxy: trust === undefined ? undefined : /^\d+$/.test(trust) ? Number(trust) : trust === 'true' });

const server = app.listen(port, () => {
  const n = store.all();
  console.log(`Binder ledger on http://localhost:${port} (${n.binders.length} binders, ${n.cards.length} cards, data in ${dataDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    updater?.stopScheduler();
    server.close(() => process.exit(0));
    // Live-update streams never finish on their own.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
