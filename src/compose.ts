// Composition root: the only code (with main.ts) that knows the concrete classes and wires them
// together. main.ts starts the server with it; tests build apps with it.

import { AccountsHealth } from '#application/accounts/accounts-health.ts';
import { CheckWatches } from '#application/alerts/check-watches.ts';
import type { AlertDeps } from '#application/alerts/deps.ts';
import type { Mailer } from '#application/alerts/ports.ts';
import { ReadAlertSettings } from '#application/alerts/read-alert-settings.ts';
import { RemoveAlertSettings } from '#application/alerts/remove-alert-settings.ts';
import { SaveAlertSettings } from '#application/alerts/save-alert-settings.ts';
import { SendTestAlert } from '#application/alerts/send-test-alert.ts';
import { AdminOverview } from '#application/admin/admin-overview.ts';
import { ChangePriceMethod } from '#application/admin/change-price-method.ts';
import { ChangePriceSchedule } from '#application/admin/change-price-schedule.ts';
import type { AdminDeps } from '#application/admin/deps.ts';
import { ListProblems } from '#application/admin/list-problems.ts';
import { MarkProblemsSeen } from '#application/admin/mark-problems-seen.ts';
import { OpenLogFile } from '#application/admin/open-log-file.ts';
import { OverviewChecks } from '#application/admin/overview-checks.ts';
import type { AdminSettingsStore, PriceChartingAccount, PriceUpdates, SecurityWatch, TokenVault } from '#application/admin/ports.ts';
import { ReadPriceSettings } from '#application/admin/read-price-settings.ts';
import { RemovePriceChartingToken } from '#application/admin/remove-pricecharting-token.ts';
import { ReportPageError } from '#application/admin/report-page-error.ts';
import { SavePriceChartingToken } from '#application/admin/save-pricecharting-token.ts';
import { SearchLogs } from '#application/admin/search-logs.ts';
import { WriteStatusFile } from '#application/admin/write-status-file.ts';
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
import { AutofillCard } from '#application/catalog/autofill-card.ts';
import { BackfillDetails } from '#application/catalog/backfill-details.ts';
import { ChooseMatch } from '#application/catalog/choose-match.ts';
import { CreateMasterSet } from '#application/catalog/create-master-set.ts';
import type { CatalogDeps } from '#application/catalog/deps.ts';
import { FillCardDetails } from '#application/catalog/fill-card-details.ts';
import { FillEveryCard } from '#application/catalog/fill-every-card.ts';
import { ListMasterSetSets } from '#application/catalog/list-master-set-sets.ts';
import { LookUpCard } from '#application/catalog/look-up-card.ts';
import type { CardDatabase, CardPricing, JobLog, TcgplayerCatalog } from '#application/catalog/ports.ts';
import { PreviewMasterSet } from '#application/catalog/preview-master-set.ts';
import { SearchAnyCard } from '#application/catalog/search-any-card.ts';
import { ShowAnyCard } from '#application/catalog/show-any-card.ts';
import { ShowAnyCardDetails } from '#application/catalog/show-any-card-details.ts';
import { WatchNewCards } from '#application/catalog/watch-new-cards.ts';
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
import { RecordTrade } from '#application/ledger/record-trade.ts';
import { UndoTrade } from '#application/ledger/undo-trade.ts';
import { PutDocument } from '#application/ledger/put-document.ts';
import { ReadLedger } from '#application/ledger/read-ledger.ts';
import { DeletePhoto } from '#application/photos/delete-photo.ts';
import { OpenPhoto } from '#application/photos/open-photo.ts';
import { UploadPhoto } from '#application/photos/upload-photo.ts';
import type { ServerLog } from '#application/logging.ts';
import type { ActivityLog, EventPublisher } from '#application/ports.ts';
import type { Category } from '#domain/admin/log.ts';
import { FileAccountStore } from '#infrastructure/accounts/auth-file.ts';
import { AdminFile } from '#infrastructure/admin/admin-file.ts';
import { FileSecret } from '#infrastructure/admin/file-secret.ts';
import { SmtpMailer } from '#infrastructure/alerts/smtp-mailer.ts';
import { MemoryAlertHistory } from '#infrastructure/memory/alerts.ts';
import { NodeDiskUsage, NodeRuntime } from '#infrastructure/admin/node-server.ts';
import { FileOffsiteRecord, FileStatusFile } from '#infrastructure/admin/status-files.ts';
import { ScryptHasher } from '#infrastructure/accounts/scrypt-hasher.ts';
import { FileSessionStore } from '#infrastructure/accounts/session-file.ts';
import { FileKeptCopies } from '#infrastructure/backups/file-kept-copies.ts';
import { PageConditionRules } from '#infrastructure/guests/condition-rules.ts';
import { FileGuestDesk } from '#infrastructure/guests/guest-file.ts';
import { QrSvg } from '#infrastructure/guests/qr-svg.ts';
import { StoreCardChanges } from '#infrastructure/json-store/card-changes.ts';
import { StoreCardLookup } from '#infrastructure/json-store/card-lookup.ts';
import { StoreLedgerChanges } from '#infrastructure/json-store/ledger-changes.ts';
import { MemoryFailedSignIns, MemoryFirstRunSetup } from '#infrastructure/memory/accounts.ts';
import { NodeSecrets } from '#infrastructure/node-secrets.ts';
import { StoreLedgerReader } from '#infrastructure/json-store/ledger-reader.ts';
import { StorePriceUpdateRecord } from '#infrastructure/json-store/price-update-record.ts';
import { JsonBinderRepository, JsonCardRepository, JsonSettingRepository } from '#infrastructure/json-store/repositories.ts';
import type { Store } from '#infrastructure/json-store/store.ts';
import { StoreUnitOfWork } from '#infrastructure/json-store/unit-of-work.ts';
import { StoreWholeLedger } from '#infrastructure/json-store/whole-ledger.ts';
import { LocalEventBus } from '#infrastructure/local-event-bus.ts';
import { quietLogger } from '#infrastructure/logging/logger.ts';
import { NodeBase64 } from '#infrastructure/node-base64.ts';
import { FilePhotoStore } from '#infrastructure/photos/file-photo-store.ts';
import type { PhotoFiles } from '#infrastructure/photos/photo-files.ts';
import { NodeScheduler } from '#infrastructure/node-scheduler.ts';
import { RandomHexIds, RandomShortIds } from '#infrastructure/random-ids.ts';
import { SystemClock } from '#infrastructure/system-clock.ts';
import { accountRoutes } from '#presentation/accounts/routes.ts';
import { adminRoutes } from '#presentation/admin/routes.ts';
import { alertRoutes } from '#presentation/alerts/routes.ts';
import { backupRoutes } from '#presentation/backups/routes.ts';
import { catalogRoutes } from '#presentation/catalog/routes.ts';
import { GuestCardFeed } from '#presentation/guests/feed.ts';
import { guestRoutes } from '#presentation/guests/routes.ts';
import type { CallerResolver } from '#presentation/http/caller.ts';
import { combine, type Router } from '#presentation/http/router.ts';
import { ledgerRoutes } from '#presentation/ledger/routes.ts';
import { photoRoutes } from '#presentation/photos/routes.ts';
import { type AppOptions, createExpressApp, type LayeredContext, type LayeredRoutes } from '../server/app.ts';
import { TodaysPrices } from '../server/pricing/any-card.ts';
import { NoToken, type PriceCharting } from '../server/pricing/pricecharting.ts';
import { Refused } from '../server/pricing/sources.ts';
import type { PriceUpdater } from '../server/pricing/updater.ts';
import type { Security } from '../server/security.ts';

/** One category of the server log, as the activity log port. */
const activityLog = (log: ServerLog, category: Category): ActivityLog => ({
  info: (message, details) => log.info(category, message, details ? { ...details } : undefined),
  warn: (message, details) => log.warn(category, message, details ? { ...details } : undefined),
});

/** One category of the server log, for work done in the background. */
const jobLog = (log: ServerLog, category: Category): JobLog => ({
  ...activityLog(log, category),
  error: (message, details) => log.error(category, message, details ? { ...details } : undefined),
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
    recordTrade: new RecordTrade(deps),
    undoTrade: new UndoTrade(deps),
  });
}

export interface CreateBackupsOptions {
  readonly store: Store;
  readonly assets: PhotoFiles;
  readonly config?: AdminSettingsStore | undefined;
  readonly log?: ServerLog | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Photos, full backups and the ledger's kept copies, over the files in the data directory. */
export function createBackups(o: CreateBackupsOptions) {
  const config = o.config ?? new AdminFile(o.store.dataDir);
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
  readonly log?: ServerLog | undefined;
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
  readonly log?: ServerLog | undefined;
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
    cards: new StoreCardLookup(o.store),
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

/** The daily price update as new cards and chosen matches use it; read when used, as it may be made after them. */
const cardPricing = (updater: () => PriceUpdater | undefined): CardPricing => ({
  canPriceNow: () => {
    const u = updater();
    return !!u && u.schedule().enabled && !u.running;
  },
  updateCard: async (id) => {
    const u = updater();
    return u ? u.updateCard(id) : 'off';
  },
});

export interface CreateCardLookupsOptions {
  readonly store: Store;
  /** The card database (TCGdex). */
  readonly database: CardDatabase;
  /** TCGplayer's own catalog (tcgcsv.com), which master sets are checked against. */
  readonly tcgcsv?: TcgplayerCatalog | undefined;
  /**
   * The daily price update, which prices new cards and any card looked up; read when it's used, as
   * the update is made after these (it fills cards' details with them).
   */
  readonly updater?: (() => PriceUpdater | undefined) | undefined;
  readonly log?: ServerLog | undefined;
  readonly events?: EventPublisher | undefined;
  readonly now?: (() => Date) | undefined;
  /** Pause between cards filled in one after another. */
  readonly delayMs?: number | undefined;
  /** How long after the watch on new cards starts to look up cards checked before an update (null: don't). */
  readonly backfillAfterMs?: number | null | undefined;
}

/**
 * Card details from the card database (looking a card up, choosing a match, filling one card or
 * every card in), new cards filling themselves in, Find a card → Any card, and master sets.
 */
export function createCardLookups(o: CreateCardLookupsOptions) {
  const log = o.log ?? quietLogger();
  const updater = o.updater ?? (() => undefined);
  const unitOfWork = new StoreUnitOfWork(o.store);
  const deps: CatalogDeps = {
    database: o.database,
    tcgplayer: o.tcgcsv ?? null,
    pricing: cardPricing(updater),
    anyCardPricing: { price: (card) => new TodaysPrices(updater()).price(card) },
    cards: new JsonCardRepository(unitOfWork),
    binders: new JsonBinderRepository(unitOfWork),
    settings: new JsonSettingRepository(unitOfWork),
    changes: new StoreCardChanges(o.store),
    unitOfWork,
    events: o.events ?? new LocalEventBus(),
    clock: { now: o.now ?? (() => new Date()) },
    ids: new RandomShortIds(),
    scheduler: new NodeScheduler(),
    log: jobLog(log, 'pricing'),
    activity: activityLog(log, 'app'),
    delayMs: o.delayMs ?? 1500,
  };
  const fillCard = new FillCardDetails(deps);
  const fillEveryCard = new FillEveryCard({ ...deps, fillCard });
  const backfill = new BackfillDetails({ ...deps, fillEvery: fillEveryCard });
  const autofillCard = new AutofillCard({ ...deps, fillCard });
  const watchNewCards = new WatchNewCards({ ...deps, autofill: autofillCard, backfill }, { backfillAfterMs: o.backfillAfterMs === undefined ? 60_000 : o.backfillAfterMs });
  return {
    lookUpCard: new LookUpCard(deps),
    fillCard,
    chooseMatch: new ChooseMatch({ ...deps, fillCard }),
    fillEveryCard,
    backfill,
    autofillCard,
    watchNewCards,
    searchAnyCard: new SearchAnyCard(deps),
    showAnyCard: new ShowAnyCard(deps),
    showAnyCardDetails: new ShowAnyCardDetails(deps),
    listMasterSetSets: new ListMasterSetSets(deps),
    previewMasterSet: new PreviewMasterSet(deps),
    createMasterSet: new CreateMasterSet(deps),
    /** The server is stopping: no further cards are filled in, by the watch or by Fill in missing details. */
    stop: () => {
      watchNewCards.stop();
      fillEveryCard.stop();
    },
  };
}

export type CardLookups = ReturnType<typeof createCardLookups>;

/** The daily price update as Administration's port. */
const priceUpdates = (updater: PriceUpdater): PriceUpdates => ({ schedule: () => updater.schedule(), noteToken: () => updater.noteToken() });

/** Rate limits and blocks, summed up for the overview's checks; off without them. */
const securityWatch = (security: Security | undefined): SecurityWatch => ({
  summary: () => {
    const s = security?.summary();
    return { enabled: !!security, bans: s?.bans.length ?? 0, limited: s?.stats.limited ?? 0, blocked: s?.stats.blocked ?? 0, allowlist: s?.allowlist.length ?? 0 };
  },
});

/** PriceCharting's API client as Administration's port: a token it refuses, or a call that failed. */
const priceChartingAccount = (api: PriceCharting): PriceChartingAccount => ({
  check: async (token) => {
    try {
      await api.check(token);
      return { outcome: 'accepted' };
    } catch (error) {
      if (error instanceof Refused || error instanceof NoToken) return { outcome: 'refused' };
      return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  },
  forget: () => api.forget(),
  usage: () => api.usageNow(),
});

export interface CreateAdminOptions {
  readonly store: Store;
  readonly assets: PhotoFiles;
  readonly config: AdminSettingsStore;
  readonly log: ServerLog;
  readonly now: () => Date;
  readonly backups: Backups;
  readonly accounts?: Accounts | undefined;
  /** BINDER_PASSWORD, for the check that it no longer opens the admin account. */
  readonly envPassword?: string | undefined;
  readonly security?: Security | undefined;
  readonly updater?: PriceUpdater | undefined;
  readonly pricecharting?: { readonly token: TokenVault; readonly api: PriceCharting } | undefined;
}

/** Administration's overview, price settings and PriceCharting token, problems, logs and status file, and the pages' error reports. */
export function createAdmin(o: CreateAdminOptions) {
  const deps: AdminDeps = {
    settings: o.config,
    log: o.log,
    clock: { now: o.now },
    disk: new NodeDiskUsage(o.store.dataDir),
    statusFile: new FileStatusFile(o.store.dataDir),
    offsite: new FileOffsiteRecord(o.store.dataDir),
    runtime: new NodeRuntime(),
    ledger: new StoreLedgerReader(o.store),
    photos: new FilePhotoStore(o.assets),
    backups: o.backups.health,
    accounts: o.accounts ? { health: o.accounts.health, envPasswordWorks: o.accounts.envPasswordWorks, envPassword: o.envPassword } : null,
    security: securityWatch(o.security),
    prices: o.updater ? priceUpdates(o.updater) : null,
    priceRecord: new StorePriceUpdateRecord(o.store),
    pricecharting: o.pricecharting ? { token: o.pricecharting.token, account: priceChartingAccount(o.pricecharting.api) } : null,
  };
  const checks = new OverviewChecks(deps);
  return {
    overview: new AdminOverview({ ...deps, checks }),
    writeStatusFile: new WriteStatusFile({ ...deps, checks }),
    readPriceSettings: new ReadPriceSettings(deps),
    changePriceSchedule: new ChangePriceSchedule(deps),
    changePriceMethod: new ChangePriceMethod(deps),
    savePriceChartingToken: new SavePriceChartingToken(deps),
    removePriceChartingToken: new RemovePriceChartingToken(deps),
    listProblems: new ListProblems(deps),
    markProblemsSeen: new MarkProblemsSeen(deps),
    searchLogs: new SearchLogs(deps),
    openLogFile: new OpenLogFile(deps),
    reportPageError: new ReportPageError(deps),
  };
}

export type Admin = ReturnType<typeof createAdmin>;

export interface CreateAlertsOptions {
  readonly store: Store;
  readonly config: AdminSettingsStore;
  /** The Gmail app password (a file of its own in SECRETS_DIR). */
  readonly password: TokenVault;
  /** Gmail's SMTP server if omitted. */
  readonly mailer?: Mailer | undefined;
  readonly log?: ServerLog | undefined;
  readonly events?: EventPublisher | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Price watches checked against cards' values, and the buy and sell alert emails they send. */
export function createAlerts(o: CreateAlertsOptions) {
  const unitOfWork = new StoreUnitOfWork(o.store);
  const deps: AlertDeps = {
    settings: o.config,
    password: o.password,
    mailer: o.mailer ?? new SmtpMailer(),
    history: new MemoryAlertHistory(),
    ledger: new StoreLedgerReader(o.store),
    cards: new JsonCardRepository(unitOfWork),
    condition: new PageConditionRules(),
    unitOfWork,
    events: o.events ?? new LocalEventBus(),
    clock: { now: o.now ?? (() => new Date()) },
    log: o.log ?? quietLogger(),
  };
  return {
    checkWatches: new CheckWatches(deps),
    readAlertSettings: new ReadAlertSettings(deps),
    saveAlertSettings: new SaveAlertSettings(deps),
    removeAlertSettings: new RemoveAlertSettings(deps),
    sendTestAlert: new SendTestAlert(deps),
  };
}

export type Alerts = ReturnType<typeof createAlerts>;

export interface CreateAppOptions extends Omit<AppOptions, 'layeredRoutes' | 'backups' | 'people'> {
  /** Card photos (backups, the overview and the guest page use them). */
  readonly assets: PhotoFiles;
  /** Photos and backups; made from the store, photos and settings if omitted. */
  readonly backups?: Backups | undefined;
  /** People and sign-in. Without them everything is open (only for running on your own computer). */
  readonly accounts?: Accounts | undefined;
  /** Guests looking through the cards listed for sale; the guest routes are absent without them. */
  readonly guests?: Guests | undefined;
  /** Where published domain events go; a private bus if omitted. */
  readonly events?: LocalEventBus | undefined;
  /** The settings only administrators change (admin.json in the data directory if omitted). */
  readonly config?: AdminSettingsStore | undefined;
  /** BINDER_PASSWORD, for the check that it no longer opens the admin account. */
  readonly envPassword?: string | undefined;
  /** Card details, Any card and master sets; made from `cardDatabase` if omitted. */
  readonly cardLookups?: CardLookups | undefined;
  /** The card database (TCGdex); without it (CARD_LOOKUPS=off) the lookup routes answer 503. */
  readonly cardDatabase?: CardDatabase | undefined;
  /** TCGplayer's own catalog (tcgcsv.com), which master sets are checked against. */
  readonly tcgcsv?: TcgplayerCatalog | undefined;
  /** Price watches and alert emails; made with the app password in <data>/secrets if omitted. */
  readonly alerts?: Alerts | undefined;
}

/** The whole app: the layered slices plugged into the Express server that still hosts the rest. */
export function createApp(options: CreateAppOptions) {
  const { events = new LocalEventBus(), accounts, guests, config: given, envPassword, cardLookups: givenLookups, cardDatabase, tcgcsv, alerts: givenAlerts, ...rest } = options;
  const log = options.log ?? quietLogger();
  const config = given ?? new AdminFile(options.store.dataDir);
  const now = options.now ?? (() => new Date());
  const backups = options.backups ?? createBackups({ store: options.store, assets: options.assets, config, log, now });
  const lookups = givenLookups ?? (cardDatabase ? createCardLookups({ store: options.store, database: cardDatabase, tcgcsv, updater: () => options.updater, log, events, now }) : null);
  const alerts = givenAlerts ?? createAlerts({ store: options.store, config, password: new FileSecret(`${options.store.dataDir}/secrets`, 'gmail-app-password'), log, events, now });
  const admin = createAdmin({ store: options.store, assets: options.assets, config, log, now, backups, accounts, envPassword, security: options.security, updater: options.updater, pricecharting: options.pricecharting });
  const layeredRoutes = (c: LayeredContext): LayeredRoutes => {
    const photos = photoRoutes({ identify: c.identify, ...backups });
    return {
      api: combine(
        accountRoutes({ identify: c.identity, client: c.client, accounts: accounts ?? null }),
        guestRoutes({ identify: c.identify, guest: c.guest, client: c.client, streams: c.streams, guests: guests ?? null }),
        composeLedgerRoutes(options.store, c.identify, activityLog(log, 'app'), events),
        photos.api,
        backupRoutes({ identify: c.identify, ...backups }),
        adminRoutes({ identify: c.identify, identity: c.identity, client: c.client, guest: guests ? c.guest : null, trustsProxy: !!options.trustProxy, ...admin }),
        catalogRoutes({ identify: c.identify, catalog: lookups }),
        alertRoutes({ identify: c.identify, ...alerts }),
      ),
      root: photos.root,
    };
  };
  const people = { identifyCaller: accounts?.identifyCaller ?? new IdentifyLocalOwner(), identifyGuest: guests?.identify ?? null };
  const app = createExpressApp({ ...rest, log, now, backups, people, layeredRoutes });
  // status.txt for the server's nightly job (main.ts writes it every five minutes).
  return Object.assign(app, { writeStatusFile: () => admin.writeStatusFile.execute() });
}
