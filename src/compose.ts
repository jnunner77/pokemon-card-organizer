// Composition root: the only code (with main.ts) that knows the concrete classes and wires them
// together. main.ts starts the server with it; tests build apps with it.

import { ChangeRetention } from '#application/backups/change-retention.ts';
import { BackupHealth } from '#application/backups/backup-health.ts';
import { DeleteCopy } from '#application/backups/delete-copy.ts';
import type { BackupDeps } from '#application/backups/deps.ts';
import { DownloadCopy } from '#application/backups/download-copy.ts';
import { DownloadFullBackup } from '#application/backups/download-full-backup.ts';
import { Housekeeping } from '#application/backups/housekeeping.ts';
import { ListCopies } from '#application/backups/list-copies.ts';
import { PruneCopies } from '#application/backups/prune-copies.ts';
import { RestoreCopy } from '#application/backups/restore-copy.ts';
import { RestoreFullBackup } from '#application/backups/restore-full-backup.ts';
import { TakeSnapshot } from '#application/backups/take-snapshot.ts';
import { ArrangeBinder } from '#application/ledger/arrange-binder.ts';
import { ChangePriceEntries } from '#application/ledger/change-price-entries.ts';
import { DeleteDocument } from '#application/ledger/delete-document.ts';
import type { LedgerDeps } from '#application/ledger/deps.ts';
import { MergeDocument } from '#application/ledger/merge-document.ts';
import { PlaceCards } from '#application/ledger/place-cards.ts';
import { PutDocument } from '#application/ledger/put-document.ts';
import { ReadLedger } from '#application/ledger/read-ledger.ts';
import { DeletePhoto } from '#application/photos/delete-photo.ts';
import { OpenPhoto } from '#application/photos/open-photo.ts';
import { UploadPhoto } from '#application/photos/upload-photo.ts';
import type { ActivityLog, Clock } from '#application/ports.ts';
import { FileKeptCopies } from '#infrastructure/backups/file-kept-copies.ts';
import { StoreLedgerReader } from '#infrastructure/json-store/ledger-reader.ts';
import { JsonBinderRepository, JsonCardRepository, JsonSettingRepository } from '#infrastructure/json-store/repositories.ts';
import type { Store } from '#infrastructure/json-store/store.ts';
import { StoreUnitOfWork } from '#infrastructure/json-store/unit-of-work.ts';
import { StoreWholeLedger } from '#infrastructure/json-store/whole-ledger.ts';
import { LocalEventBus } from '#infrastructure/local-event-bus.ts';
import { NodeBase64 } from '#infrastructure/node-base64.ts';
import { FilePhotoStore } from '#infrastructure/photos/file-photo-store.ts';
import type { PhotoFiles } from '#infrastructure/photos/photo-files.ts';
import { RandomHexIds } from '#infrastructure/random-ids.ts';
import { backupRoutes } from '#presentation/backups/routes.ts';
import type { CallerResolver } from '#presentation/http/caller.ts';
import { combine, type Router } from '#presentation/http/router.ts';
import { ledgerRoutes } from '#presentation/ledger/routes.ts';
import { photoRoutes } from '#presentation/photos/routes.ts';
import { type AppOptions, createExpressApp, type LayeredRoutes } from '../server/app.ts';
import { Config } from '../server/config.ts';
import { type Category, type Logger, quietLogger } from '../server/log.ts';

/** One category of the server log, as the activity log port. */
const activityLog = (log: Logger, category: Category): ActivityLog => ({
  info: (message, details) => log.info(category, message, details ? { ...details } : undefined),
  warn: (message, details) => log.warn(category, message, details ? { ...details } : undefined),
});

/** The ledger slice over the JSON store, as HTTP routes relative to /api. */
export function composeLedgerRoutes(store: Store, identify: CallerResolver, activity: ActivityLog, events: LocalEventBus, clock: Clock): Router {
  const unitOfWork = new StoreUnitOfWork(store);
  const deps: LedgerDeps = {
    cards: new JsonCardRepository(unitOfWork),
    binders: new JsonBinderRepository(unitOfWork),
    settings: new JsonSettingRepository(unitOfWork),
    reader: new StoreLedgerReader(store),
    clock,
    events,
    unitOfWork,
    activity,
  };
  return ledgerRoutes({
    identify,
    readLedger: new ReadLedger(deps),
    putDocument: new PutDocument(deps),
    mergeDocument: new MergeDocument(deps),
    deleteDocument: new DeleteDocument(deps),
    changePriceEntries: new ChangePriceEntries(deps),
    arrangeBinder: new ArrangeBinder(deps),
    placeCards: new PlaceCards(deps),
  });
}

export interface CreateBackupsOptions {
  readonly store: Store;
  readonly assets: PhotoFiles;
  readonly config?: Config | undefined;
  readonly log?: Logger | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Photos, full backups and the ledger's kept copies, over the files in the data directory. */
export function createBackups(o: CreateBackupsOptions) {
  const config = o.config ?? new Config(o.store.dataDir);
  const log = o.log ?? quietLogger();
  const now = o.now ?? (() => new Date());
  const ledger = new StoreWholeLedger(o.store);
  const deps: BackupDeps = {
    photos: new FilePhotoStore(o.assets),
    ledgerPhotos: ledger,
    copies: new FileKeptCopies(o.store.backupDir, o.store.file),
    ledger,
    settings: {
      retention: () => config.get().backups,
      setRetention: (retention) => void config.set({ backups: { ...retention } }),
      lastFullBackupAt: () => config.get().lastFullBackupAt,
      noteFullBackup: (at) => void config.set({ lastFullBackupAt: at.toISOString() }),
    },
    clock: { now },
    base64: new NodeBase64(),
    log: activityLog(log, 'backup'),
    adminLog: activityLog(log, 'admin'),
  };
  const prune = new PruneCopies(deps);
  return {
    uploadPhoto: new UploadPhoto({ photos: deps.photos, ids: new RandomHexIds() }),
    deletePhoto: new DeletePhoto(deps),
    openPhoto: new OpenPhoto(deps),
    downloadFullBackup: new DownloadFullBackup(deps),
    restoreFullBackup: new RestoreFullBackup(deps),
    listCopies: new ListCopies(deps),
    changeRetention: new ChangeRetention({ ...deps, prune }),
    takeSnapshot: new TakeSnapshot({ ...deps, prune }),
    downloadCopy: new DownloadCopy(deps),
    restoreCopy: new RestoreCopy(deps),
    deleteCopy: new DeleteCopy(deps),
    pruneCopies: prune,
    health: new BackupHealth(deps),
    housekeeping: new Housekeeping({ ...deps, prune }),
  };
}

export type Backups = ReturnType<typeof createBackups>;

export interface CreateAppOptions extends Omit<AppOptions, 'layeredRoutes' | 'backups'> {
  /** Photos and backups; made from the store, photos and settings if omitted. */
  readonly backups?: Backups | undefined;
  /** Where published domain events go; a private bus if omitted. */
  readonly events?: LocalEventBus | undefined;
}

/** The whole app: the layered slices plugged into the Express server that still hosts the rest. */
export function createApp(options: CreateAppOptions) {
  const { events = new LocalEventBus(), ...rest } = options;
  const log = options.log ?? quietLogger();
  const config = options.config ?? new Config(options.store.dataDir);
  const now = options.now ?? (() => new Date());
  const backups = options.backups ?? createBackups({ store: options.store, assets: options.assets, config, log, now });
  const layeredRoutes = ({ identify }: { identify: CallerResolver }): LayeredRoutes => {
    const photos = photoRoutes({ identify, ...backups });
    return {
      api: combine(composeLedgerRoutes(options.store, identify, activityLog(log, 'app'), events, { now: () => new Date() }), photos.api, backupRoutes({ identify, ...backups })),
      root: photos.root,
    };
  };
  return createExpressApp({ ...rest, log, config, now, backups, layeredRoutes });
}
