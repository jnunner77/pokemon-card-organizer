// New cards fill themselves in: as soon as a card is added (the form, a CSV import, the API) or
// becomes a different card (a CSV row replacing it, or its name or number edited),
// its empty details are looked up (details.ts) and then its price and official picture
// (pricing/updater.ts), instead of waiting for the next morning's run. Cards are handled one at
// a time with a pause between them, so a big import doesn't hammer the sites.
//
// Also "Fill in missing details" for the cards already in the ledger, with its progress in
// settings/details. It runs by itself shortly after the server starts when cards were looked up
// before the current checks (a one-off backfill after an update that adds some).

import { CardDetails, type DetailsStatus } from './details';
import { type Logger, quietLogger } from './log';
import type { PriceUpdater } from './pricing/updater';
import type { Doc } from './schema';
import type { Store } from './store';

export interface AutofillOptions {
  store: Store;
  details: CardDetails;
  /** Without it (or with automatic prices turned off) only details are filled. */
  updater?: PriceUpdater;
  log?: Logger;
  /** Pause between cards. */
  delayMs?: number;
  /** How long after start() to check for cards needing a release date (null: don't). */
  backfillAfterMs?: number | null;
}

type FillRun = { running: boolean; done: number; total: number; startedAt?: string; lastRun?: Doc };

export class Autofill {
  private readonly store: Store;
  private readonly details: CardDetails;
  private readonly updater?: PriceUpdater;
  private readonly log: Logger;
  private readonly delayMs: number;
  /** Each card's name and number, to notice when a card becomes a different one. */
  private known = new Map<string, string>();
  private readonly queue: string[] = [];
  /** Queued cards that were a different card before (their old automatic match is dropped). */
  private readonly changed = new Set<string>();
  private working: Promise<void> | null = null;
  private filling: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly backfillAfterMs: number | null;
  private backfillTimer: NodeJS.Timeout | null = null;

  constructor(o: AutofillOptions) {
    this.store = o.store;
    this.details = o.details;
    this.updater = o.updater;
    this.log = o.log ?? quietLogger();
    this.delayMs = o.delayMs ?? 1500;
    this.backfillAfterMs = o.backfillAfterMs === undefined ? 60_000 : o.backfillAfterMs;
  }

  /**
   * Watch for new cards, and for cards whose name or number changes (a CSV row replacing the card
   * in a pocket keeps that card's id). Cards already there, or brought back by a restore, aren't new.
   */
  start() {
    const snapshot = () => new Map(this.store.all().cards.map((c) => [c.id, identity(c)]));
    this.known = snapshot();
    this.unsubscribe = this.store.subscribe((e) => {
      if (e.type === 'reset') {
        this.known = snapshot();
        return;
      }
      const { collection, id, doc } = e.change;
      if (collection !== 'cards') return;
      if (!doc) {
        this.known.delete(id);
        return;
      }
      const now = identity(doc);
      const before = this.known.get(id);
      if (before === now) return;
      this.known.set(id, now);
      if (before !== undefined) this.changed.add(id);
      this.enqueue(id);
    });
    if (this.backfillAfterMs != null) {
      this.backfillTimer = setTimeout(() => this.backfill(), this.backfillAfterMs);
      this.backfillTimer.unref?.();
    }
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
    this.backfillTimer = null;
  }

  /**
   * Cards looked up before the current checks (release dates, the set a card is filed under,
   * suggested names), and cards never looked up (complete before details were filled in).
   * Returns how many cards it looks at.
   */
  backfill(): number {
    const cards = this.store.all().cards;
    const need = cards.filter((c) => this.details.wants(c) && (CardDetails.outdated(c) || !((c as Doc).details as DetailsStatus | null | undefined)?.checkedAt)).length;
    if (!need || this.filling) return 0;
    this.log.info('pricing', `${need} cards to look up or check again after an update`);
    return this.fillAll(false);
  }

  /** Resolves when every queued card has been handled (for tests and shutdown). */
  idle(): Promise<void> {
    return this.working ?? Promise.resolve();
  }

  private enqueue(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.working ??= this.drain().finally(() => {
      this.working = null;
    });
  }

  private async drain() {
    // Let the request that added the card finish first (and a CSV import add the rest).
    await pause(200);
    while (this.queue.length) {
      const id = this.queue.shift()!;
      try {
        await this.complete(id);
      } catch (err) {
        this.log.warn('pricing', `Filling in a new card failed: ${err instanceof Error ? err.message : err}`);
      }
      if (this.queue.length) await pause(this.delayMs);
    }
  }

  /** One new (or changed) card: its details, then its price and picture. */
  private async complete(id: string) {
    const card = this.store.get('cards', id);
    const changed = this.changed.delete(id);
    if (!card) return;
    const label = [card.name || 'Unnamed card', card.setCode || card.set, card.number].filter(Boolean).join(' ');
    // A card that became a different one: its TCGdex match and release date were for the old
    // card, and so was an automatic price match (one the person chose is kept).
    if (changed) {
      const link = card.pricing as { linkedBy?: string } | null | undefined;
      const auto = link && link.linkedBy !== 'user';
      this.store.update('cards', id, { details: null, released: null, ...(auto ? { pricing: null, officialImageId: null } : {}) });
    }
    const result = await this.details.fill(this.store, id, changed);
    if (result === 'filled') {
      const d = this.store.get('cards', id)?.details as DetailsStatus | undefined;
      this.log.info('pricing', `Filled in ${label}: ${(d?.filled ?? []).join(', ')} from TCGdex`);
    }
    const u = this.updater;
    if (!u || !u.schedule().enabled) return;
    // The daily run is about to price it anyway.
    if (u.running) return;
    const outcome = await u.updateCard(id);
    this.log.info('pricing', `${changed ? 'Changed' : 'New'} card ${label}: ${OUTCOME[outcome] ?? outcome}`);
  }

  // ---- Fill in missing details (all cards) --------------------------------------------

  private status(): FillRun {
    return (this.store.get('settings', 'details') as FillRun | undefined) ?? { running: false, done: 0, total: 0 };
  }
  private setStatus(patch: Partial<FillRun>) {
    this.store.set('settings', 'details', { ...this.status(), ...patch });
  }
  get fillingAll() {
    return !!this.filling;
  }

  /** Cards with blanks to fill (force: also those looked up in the last week). */
  missing(force = false) {
    return this.store
      .all()
      .cards.filter((c) => this.details.wants(c, force))
      .map((c) => c.id);
  }

  /** Look up every card with blanks, one at a time. Returns how many it will look at. */
  fillAll(force = false): number {
    if (this.filling) return this.status().total;
    const ids = this.missing(force);
    const startedAt = new Date().toISOString();
    this.setStatus({ running: true, done: 0, total: ids.length, startedAt });
    this.log.info('pricing', `Filling in missing details for ${ids.length} cards`);
    this.filling = (async () => {
      const counts: Record<string, number> = { filled: 0, complete: 0, several: 0, notFound: 0, error: 0, skipped: 0 };
      let done = 0;
      try {
        for (const id of ids) {
          const r = await this.details.fill(this.store, id, force).catch(() => 'error' as const);
          counts[r] = (counts[r] ?? 0) + 1;
          this.setStatus({ done: ++done });
          if (r !== 'skipped') await pause(this.delayMs / 3);
        }
      } finally {
        this.setStatus({ running: false, lastRun: { startedAt, finishedAt: new Date().toISOString(), cards: ids.length, ...counts } });
        this.log.info('pricing', `Filled in missing details: ${counts.filled} cards filled, ${counts.several} with several matches, ${counts.notFound} not found, ${counts.error} failed`, counts);
      }
    })().finally(() => {
      this.filling = null;
    });
    return ids.length;
  }

  /** Resolves when Fill in missing details has finished (for tests). */
  filled(): Promise<void> {
    return this.filling ?? Promise.resolve();
  }
}

const OUTCOME: Record<string, string> = {
  updated: 'price and picture found',
  needsMatch: 'no certain match on the price sites; choose one in its drawer',
  noPrice: 'matched, but no price yet',
  failed: 'the price sites did not answer; the daily run tries again',
  skipped: 'skipped',
  off: 'automatic pricing is off for it',
};

/** What makes a card that card: its name and number, however they're spaced or capitalised. */
const identity = (c: Doc) => `${String(c.name ?? '').trim().toLowerCase()}\u0000${String(c.number ?? '').replace(/\s+/g, '').toLowerCase()}`;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
