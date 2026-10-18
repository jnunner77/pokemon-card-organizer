// Composition root: the only code (with main.ts) that knows the concrete classes and wires them
// together. main.ts starts the server with it; tests build apps with it.

import { AccountsHealth } from '#application/accounts/accounts-health.ts';
import { Bootstrap } from '#application/accounts/bootstrap.ts';
import { ChangeOwnPassword } from '#application/accounts/change-own-password.ts';
import { ChangeSignInSettings } from '#application/accounts/change-sign-in-settings.ts';
import { CreatePerson } from '#application/accounts/create-person.ts';
import { CreateToken } from '#application/accounts/create-token.ts';
import { DeletePerson } from '#application/accounts/delete-person.ts';
import type { AccountDeps } from '#application/accounts/deps.ts';
import { EndSession } from '#application/accounts/end-session.ts';
import { EnvPasswordWorks } from '#application/accounts/env-password-works.ts';
import { FlushSessions } from '#application/accounts/flush-sessions.ts';
import { IdentifyCaller } from '#application/accounts/identify-caller.ts';
import { IdentifyLocalOwner } from '#application/accounts/identify-local-owner.ts';
import { ListPeople } from '#application/accounts/list-people.ts';
import { ListSessions } from '#application/accounts/list-sessions.ts';
import { ListTokens } from '#application/accounts/list-tokens.ts';
import { RevokeToken } from '#application/accounts/revoke-token.ts';
import { SetPersonPassword } from '#application/accounts/set-person-password.ts';
import { SetUpFirstAdmin } from '#application/accounts/set-up-first-admin.ts';
import { SignIn } from '#application/accounts/sign-in.ts';
import { SignInStatus } from '#application/accounts/sign-in-status.ts';
import { SignOut } from '#application/accounts/sign-out.ts';
import { SignPersonOut } from '#application/accounts/sign-person-out.ts';
import { UpdatePerson } from '#application/accounts/update-person.ts';
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
import { ClearGuestLog } from '#application/guests/clear-guest-log.ts';
import type { GuestDeps } from '#application/guests/deps.ts';
import { EndGuestVisit } from '#application/guests/end-guest-visit.ts';
import { GuestOverview } from '#application/guests/guest-overview.ts';
import { GuestStatus } from '#application/guests/guest-status.ts';
import { IdentifyGuest } from '#application/guests/identify-guest.ts';
import { ListGuestCards } from '#application/guests/list-guest-cards.ts';
import { NewGuestKey } from '#application/guests/new-guest-key.ts';
import { OpenGuestPicture } from '#application/guests/open-guest-picture.ts';
import { ReadGuestViewing } from '#application/guests/read-guest-viewing.ts';
import { SetGuestViewing } from '#application/guests/set-guest-viewing.ts';
import { SignInGuest } from '#application/guests/sign-in-guest.ts';
import { SignOutGuest } from '#application/guests/sign-out-guest.ts';
import { SweepGuests } from '#application/guests/sweep-guests.ts';
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
import type { ActivityLog } from '#application/ports.ts';
import { FileAccountStore } from '#infrastructure/accounts/auth-file.ts';
import { ScryptHasher } from '#infrastructure/accounts/scrypt-hasher.ts';
import { FileSessionStore } from '#infrastructure/accounts/session-file.ts';
import { FileKeptCopies } from '#infrastructure/backups/file-kept-copies.ts';
import { PageConditionRules } from '#infrastructure/guests/condition-rules.ts';
import { FileGuestDesk } from '#infrastructure/guests/guest-file.ts';
import { QrSvg } from '#infrastructure/guests/qr-svg.ts';
import { StoreLedgerChanges } from '#infrastructure/json-store/ledger-changes.ts';
import { MemoryFailedSignIns, MemoryFirstRunSetup } from '#infrastructure/memory/accounts.ts';
import { NodeSecrets } from '#infrastructure/node-secrets.ts';
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
import { SystemClock } from '#infrastructure/system-clock.ts';
import { accountRoutes } from '#presentation/accounts/routes.ts';
import { backupRoutes } from '#presentation/backups/routes.ts';
import { GuestCardFeed } from '#presentation/guests/feed.ts';
import { guestRoutes } from '#presentation/guests/routes.ts';
import type { CallerResolver } from '#presentation/http/caller.ts';
import { combine, type Router } from '#presentation/http/router.ts';
import { ledgerRoutes } from '#presentation/ledger/routes.ts';
import { photoRoutes } from '#presentation/photos/routes.ts';
import { type AppOptions, createExpressApp, type LayeredContext, type LayeredRoutes } from '../server/app.ts';
import { Config } from '../server/config.ts';
import { type Category, type Logger, quietLogger } from '../server/log.ts';

/** One category of the server log, as the activity log port. */
const activityLog = (log: Logger, category: Category): ActivityLog => ({
  info: (message, details) => log.info(category, message, details ? { ...details } : undefined),
  warn: (message, details) => log.warn(category, message, details ? { ...details } : undefined),
});

/** The ledger slice over the JSON store, as HTTP routes relative to /api. */
export function composeLedgerRoutes(store: Store, identify: CallerResolver, activity: ActivityLog, events: LocalEventBus): Router {
  const unitOfWork = new StoreUnitOfWork(store);
  const deps: LedgerDeps = {
    cards: new JsonCardRepository(unitOfWork),
    binders: new JsonBinderRepository(unitOfWork),
    settings: new JsonSettingRepository(unitOfWork),
    reader: new StoreLedgerReader(store),
    clock: new SystemClock(),
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

export interface CreateAccountsOptions {
  readonly dataDir: string;
  readonly log?: Logger | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * People, sign-in and API tokens, over auth.json and sessions.json in the data directory. Throws
 * when auth.json is damaged: the server stops rather than start with nobody.
 */
export function createAccounts(o: CreateAccountsOptions) {
  const log = o.log ?? quietLogger();
  const deps: AccountDeps = {
    accounts: new FileAccountStore(o.dataDir),
    sessions: new FileSessionStore(o.dataDir, (message) => log.error('auth', message)),
    failures: new MemoryFailedSignIns(),
    setup: new MemoryFirstRunSetup(),
    hasher: new ScryptHasher(),
    secrets: new NodeSecrets(),
    clock: { now: o.now ?? (() => new Date()) },
    authLog: activityLog(log, 'auth'),
    adminLog: activityLog(log, 'admin'),
    securityLog: activityLog(log, 'security'),
  };
  return {
    bootstrap: new Bootstrap(deps),
    identifyCaller: new IdentifyCaller(deps),
    status: new SignInStatus(deps),
    signIn: new SignIn(deps),
    changeOwnPassword: new ChangeOwnPassword(deps),
    setUpFirstAdmin: new SetUpFirstAdmin(deps),
    signOut: new SignOut(deps),
    listPeople: new ListPeople(deps),
    createPerson: new CreatePerson(deps),
    updatePerson: new UpdatePerson(deps),
    setPersonPassword: new SetPersonPassword(deps),
    signPersonOut: new SignPersonOut(deps),
    deletePerson: new DeletePerson(deps),
    changeSettings: new ChangeSignInSettings(deps),
    listSessions: new ListSessions(deps),
    endSession: new EndSession(deps),
    listTokens: new ListTokens(deps),
    createToken: new CreateToken(deps),
    revokeToken: new RevokeToken(deps),
    health: new AccountsHealth(deps),
    envPasswordWorks: new EnvPasswordWorks(deps),
    flushSessions: new FlushSessions(deps),
  };
}

export type Accounts = ReturnType<typeof createAccounts>;

export interface CreateGuestsOptions {
  readonly store: Store;
  readonly assets: PhotoFiles;
  readonly log?: Logger | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Guests from the QR code, over guests.json in the data directory (signed-in guests in memory). */
export function createGuests(o: CreateGuestsOptions) {
  const log = o.log ?? quietLogger();
  const now = o.now ?? (() => new Date());
  const secrets = new NodeSecrets();
  const deps: GuestDeps = {
    desk: new FileGuestDesk({ dataDir: o.store.dataDir, now, newKey: () => secrets.guestKey(), onDamaged: (message) => log.error('app', message) }),
    ledger: new StoreLedgerReader(o.store),
    photos: new FilePhotoStore(o.assets),
    condition: new PageConditionRules(),
    qr: new QrSvg(),
    secrets,
    base64: new NodeBase64(),
    clock: { now },
    authLog: activityLog(log, 'auth'),
    adminLog: activityLog(log, 'admin'),
  };
  const listCards = new ListGuestCards(deps);
  return {
    viewing: new ReadGuestViewing(deps),
    status: new GuestStatus(deps),
    signIn: new SignInGuest(deps),
    identify: new IdentifyGuest(deps),
    signOut: new SignOutGuest(deps),
    listCards,
    openPicture: new OpenGuestPicture(deps),
    overview: new GuestOverview(deps),
    setViewing: new SetGuestViewing(deps),
    newKey: new NewGuestKey(deps),
    endVisit: new EndGuestVisit(deps),
    clearLog: new ClearGuestLog(deps),
    sweep: new SweepGuests(deps),
    feed: new GuestCardFeed(() => listCards.execute(), new StoreLedgerChanges(o.store)),
  };
}

export type Guests = ReturnType<typeof createGuests>;

export interface CreateAppOptions extends Omit<AppOptions, 'layeredRoutes' | 'backups' | 'people'> {
  /** Photos and backups; made from the store, photos and settings if omitted. */
  readonly backups?: Backups | undefined;
  /** People and sign-in. Without them everything is open (only for running on your own computer). */
  readonly accounts?: Accounts | undefined;
  /** Guests looking through the cards listed for sale; the guest routes are absent without them. */
  readonly guests?: Guests | undefined;
  /** Where published domain events go; a private bus if omitted. */
  readonly events?: LocalEventBus | undefined;
}

/** The whole app: the layered slices plugged into the Express server that still hosts the rest. */
export function createApp(options: CreateAppOptions) {
  const { events = new LocalEventBus(), accounts, guests, ...rest } = options;
  const log = options.log ?? quietLogger();
  const config = options.config ?? new Config(options.store.dataDir);
  const now = options.now ?? (() => new Date());
  const backups = options.backups ?? createBackups({ store: options.store, assets: options.assets, config, log, now });
  const layeredRoutes = (c: LayeredContext): LayeredRoutes => {
    const photos = photoRoutes({ identify: c.identify, ...backups });
    return {
      api: combine(
        accountRoutes({ identify: c.identity, client: c.client, accounts: accounts ?? null }),
        guestRoutes({ identify: c.identify, guest: c.guest, client: c.client, streams: c.streams, guests: guests ?? null }),
        composeLedgerRoutes(options.store, c.identify, activityLog(log, 'app'), events),
        photos.api,
        backupRoutes({ identify: c.identify, ...backups }),
      ),
      root: photos.root,
    };
  };
  const people = {
    identifyCaller: accounts?.identifyCaller ?? new IdentifyLocalOwner(),
    identifyGuest: guests?.identify ?? null,
    health: accounts?.health ?? null,
    envPasswordWorks: accounts?.envPasswordWorks ?? null,
  };
  return createExpressApp({ ...rest, log, config, now, backups, people, layeredRoutes });
}
