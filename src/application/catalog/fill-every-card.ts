import { wantsDetails } from '#domain/catalog/details.ts';
import { documentId } from '#domain/ledger/ids.ts';
import { Setting, type SettingId } from '#domain/settings/setting.ts';
import { ok } from '#shared/result.ts';
import { commit } from '../ledger/commit.ts';
import { readCards } from './cards.ts';
import type { CatalogDeps } from './deps.ts';
import type { FillCardDetails, FillResult } from './fill-card-details.ts';

/** Where Fill in missing details keeps its progress, for the page. */
const PROGRESS = documentId<SettingId>('details');

export interface FillEveryCardInput {
  /** Who started it, for the log (none when the server did). */
  readonly actor?: string | undefined;
  /** Also the cards looked up in the last week. */
  readonly force?: boolean | undefined;
}

type Deps = Pick<CatalogDeps, 'cards' | 'settings' | 'unitOfWork' | 'events' | 'clock' | 'scheduler' | 'log' | 'delayMs'>;

/**
 * Fill in missing details: look up every card with blanks, one at a time, with its progress in
 * settings/details. Starting it again while it runs changes nothing.
 */
export class FillEveryCard {
  readonly #deps: Deps;
  readonly #fill: Pick<FillCardDetails, 'execute'>;
  /** The run going on: how many cards it looks at, and when it's done. */
  #run: { readonly cards: Promise<number>; readonly done: Promise<void> } | null = null;
  #stopping = false;

  constructor(deps: Deps & { readonly fillCard: Pick<FillCardDetails, 'execute'> }) {
    this.#deps = deps;
    this.#fill = deps.fillCard;
  }

  /** Whether it's running now. */
  get running(): boolean {
    return this.#run !== null;
  }

  /** Start it; how many cards it looks at (when it was running already, how many that run looks at). */
  async execute(input: FillEveryCardInput = {}): Promise<{ readonly started: boolean; readonly cards: number }> {
    if (this.#run) return { started: false, cards: await this.#run.cards };
    const force = input.force ?? false;
    const now = this.#deps.clock.now();
    // Claimed before anything is read, so a second start meanwhile joins this run.
    const ids = readCards(this.#deps).then((cards) => cards.filter((c) => wantsDetails(c.fields, now, force)).map((c) => c.id));
    const done = ids
      .then((list) => this.#fillAll(list, force))
      .catch((error: unknown) => this.#deps.log.error(`Filling in missing details stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`))
      .finally(() => {
        this.#run = null;
        this.#stopping = false;
      });
    this.#run = { cards: ids.then((list) => list.length, () => 0), done };
    const cards = (await ids).length;
    if (input.actor) this.#deps.log.info(`${input.actor} started Fill in missing details (${cards} cards)`);
    return { started: true, cards };
  }

  /** Resolves when the run (if any) has finished. */
  finished(): Promise<void> {
    return this.#run?.done ?? Promise.resolve();
  }

  /**
   * The server is stopping: no further card is started, and the run saves how far it got once the
   * card being looked up now is done (if the server is still running then).
   */
  stop(): void {
    if (this.#run) this.#stopping = true;
  }

  async #fillAll(ids: readonly string[], force: boolean): Promise<void> {
    const { log, scheduler, clock, delayMs } = this.#deps;
    const startedAt = clock.now().toISOString();
    await this.#progress({ running: true, done: 0, total: ids.length, startedAt });
    log.info(`Filling in missing details for ${ids.length} cards`);
    const counts: Record<FillResult, number> = { filled: 0, complete: 0, several: 0, notFound: 0, error: 0, skipped: 0 };
    let done = 0;
    try {
      for (const id of ids) {
        if (this.#stopping) break;
        const r = await this.#fill.execute({ cardId: id, force }).catch((): FillResult => 'error');
        counts[r] += 1;
        await this.#progress({ done: ++done });
        if (r !== 'skipped') await scheduler.pause(delayMs / 3);
      }
    } finally {
      await this.#progress({ running: false, lastRun: { startedAt, finishedAt: clock.now().toISOString(), cards: ids.length, ...counts } });
      log.info(`Filled in missing details: ${counts.filled} cards filled, ${counts.several} with several matches, ${counts.notFound} not found, ${counts.error} failed`, counts);
    }
  }

  /** Save some of the progress, keeping the rest. */
  async #progress(patch: Readonly<Record<string, unknown>>): Promise<void> {
    const { settings, clock } = this.#deps;
    const now = clock.now();
    if (!PROGRESS.ok) throw new Error('Fill in missing details has no setting to keep its progress in');
    const id = PROGRESS.value;
    const saved = await commit(this.#deps, async () => {
      let setting = await settings.findById(id);
      if (setting) {
        const merged = setting.merge(patch, now);
        if (!merged.ok) return merged;
      } else {
        const made = Setting.create(id, { running: false, done: 0, total: 0, ...patch }, now);
        if (!made.ok) return made;
        setting = made.value;
      }
      await settings.save(setting);
      return ok({ value: undefined, events: setting.pullEvents() });
    });
    if (!saved.ok) throw new Error(`Fill in missing details couldn't save its progress: ${saved.error.message}`);
  }
}
