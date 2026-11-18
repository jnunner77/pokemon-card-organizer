import { isCurrent, japaneseCardsOf, japaneseSetOf, MAX_CARDS, nextRefresh, refreshPlan } from '#domain/catalog/japanese.ts';
import type { CatalogDeps } from './deps.ts';
import { messageOf } from './errors.ts';

type Deps = Pick<CatalogDeps, 'japanese' | 'scheduler' | 'clock' | 'log'> & {
  /** Called once when the very first build finishes (cards waiting for the Japanese catalog are looked up then). */
  readonly afterFirstBuild?: (() => void) | undefined;
};

/**
 * Keeps the Japanese card index up to date: built from TCGplayer's Japanese catalog once (about
 * ten minutes of downloads at one set a second), then refreshed once a day, downloading only the
 * sets TCGplayer says changed plus a few of the oldest as a safety net. Sets are put into the
 * index as they arrive, so lookups never wait for it, and the index is saved every few sets. It
 * runs in the background, paced, and stops when the server does.
 */
export class RefreshJapaneseCatalog {
  /** Pause between sets (tcgcsv.com is one person's hobby). */
  static readonly gapMs = 1000;
  /** Sets downloaded between saves of the index. */
  static readonly saveEvery = 25;
  /** How long after the server starts the first build or a missed refresh begins. */
  static readonly firstRunAfterMs = 2 * 60_000;
  /** Sets in a row that fail before the source counts as down and the run stops. */
  static readonly giveUpAfter = 3;
  /** How long after a failed run the next one is tried. */
  static readonly retryAfterMs = 60 * 60_000;

  readonly #deps: Deps;
  #stopped = false;
  #cancel: (() => void) | null = null;
  #running: Promise<unknown> | null = null;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** Load the saved index and schedule the first run; nothing without Japanese lookups. */
  start(): void {
    const japanese = this.#deps.japanese;
    if (!japanese) return;
    void (async () => {
      try {
        const data = await japanese.store.load();
        if (data) japanese.catalog.load(data);
        else this.#deps.log.info('Japanese card index: rebuilding it');
      } catch (error) {
        this.#deps.log.warn(`Japanese card index: couldn't read the saved index: ${messageOf(error)}`);
      }
      if (this.#stopped) return;
      const now = this.#deps.clock.now();
      const wait = isCurrent(japanese.catalog.completedAt, now) ? nextRefresh(now).getTime() - now.getTime() : RefreshJapaneseCatalog.firstRunAfterMs;
      this.#schedule(wait);
    })();
  }

  /** The server is stopping: nothing more is downloaded or scheduled. */
  stop(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
  }

  /** Resolves when the run in progress is done (for tests). */
  async idle(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  /** Bring the index up to date; how many sets were downloaded and dropped, and whether it stopped on a failure. */
  async execute(): Promise<{ readonly fetched: number; readonly dropped: number; readonly failed: boolean }> {
    const japanese = this.#deps.japanese;
    if (!japanese || this.#stopped || japanese.catalog.progress.running) return { fetched: 0, dropped: 0, failed: false };
    const run = this.#run(japanese);
    this.#running = run;
    return run;
  }

  async #run(japanese: NonNullable<Deps['japanese']>): Promise<{ readonly fetched: number; readonly dropped: number; readonly failed: boolean }> {
    const { catalog, tcgplayer, store } = japanese;
    const { clock, scheduler, log } = this.#deps;
    const firstBuild = catalog.completedAt === null;
    let fetched = 0;
    let dropped = 0;
    let failed = false;
    catalog.progress = { running: true, done: 0, total: 0 };
    const save = async () => {
      try {
        await store.save(catalog.data());
      } catch (error) {
        log.error(`Japanese card index: couldn't save it: ${messageOf(error)}`);
      }
    };
    try {
      const now = clock.now();
      tcgplayer.reset();
      const groups = await tcgplayer.groupList();
      // An empty list with sets stored is a bad answer, not TCGplayer dropping everything.
      if (groups.length === 0 && catalog.sets().length > 0) throw new Error('tcgcsv.com listed no sets, so the index is kept as it is');
      const plan = refreshPlan(catalog.sets(), groups, now);
      for (const id of plan.drop) catalog.drop(id);
      dropped = plan.drop.length;
      for (const s of plan.meta) catalog.updateMeta(s);
      catalog.progress = { running: true, done: 0, total: plan.fetch.length };
      const byId = new Map(groups.map((g) => [g.groupId, g]));
      let full = false;
      let skipped = 0;
      let inARow = 0;
      for (const id of plan.fetch) {
        if (this.#stopped) break;
        const group = byId.get(id);
        if (!group) continue;
        let products;
        try {
          products = await tcgplayer.products(id);
          inARow = 0;
        } catch (error) {
          // One set's bad answer leaves that set out (it isn't stored, so the next run fetches it again);
          // several in a row (or the client's breaker) mean the source is down, which fails the run.
          skipped++;
          inARow++;
          log.warn(`Japanese card index: set ${id} skipped: ${messageOf(error)}`);
          if (inARow >= RefreshJapaneseCatalog.giveUpAfter) throw error;
          continue;
        }
        if (!catalog.put(japaneseSetOf(group, now.toISOString()), japaneseCardsOf(products)) && !full) {
          full = true;
          log.error(`Japanese card index is full (${MAX_CARDS} cards); later sets are left out`);
        }
        fetched++;
        catalog.progress = { running: true, done: fetched, total: plan.fetch.length };
        if (fetched % RefreshJapaneseCatalog.saveEvery === 0) await save();
        await scheduler.pause(RefreshJapaneseCatalog.gapMs);
      }
      if (!this.#stopped) catalog.completedAt = now.toISOString();
      if (skipped > 0) log.warn(`Japanese card index: ${skipped} sets skipped, to be tried again at the next run`);
      log.info(`Japanese card index: ${fetched} sets downloaded (${plan.fetch.length} changed), ${catalog.cardCount()} cards`);
    } catch (error) {
      failed = true;
      log.warn(`Japanese card index: ${messageOf(error)}`);
    }
    await save();
    catalog.progress = { ...catalog.progress, running: false };
    if (!failed && !this.#stopped && firstBuild) this.#deps.afterFirstBuild?.();
    if (!this.#stopped) this.#schedule(failed ? RefreshJapaneseCatalog.retryAfterMs : nextRefresh(clock.now()).getTime() - clock.now().getTime());
    return { fetched, dropped, failed };
  }

  #schedule(ms: number): void {
    this.#cancel?.();
    this.#cancel = this.#deps.scheduler.after(ms, () => void this.execute().catch(() => undefined));
  }
}
