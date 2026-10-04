import type { Assets } from '../assets';
import { MAX_IMAGE_BYTES } from '../assets';
import type { Config } from '../config';
import type { CardDetails } from '../details';
import { type Logger, quietLogger } from '../log';
import type { Doc } from '../schema';
import type { Store } from '../store';
import { chooseMatch, detailsFromProduct, searchQuery, type CardForMatch } from './match';
import {
  type Candidate,
  type Fetcher,
  ProductGone,
  type Quote,
  type Source,
  SourceError,
  get,
  pcPath,
  quotePriceCharting,
  quoteTcgplayer,
  searchPriceCharting,
  searchTcgplayer,
  usdToCad,
} from './sources';

// The daily price and image update. For every card still in the collection it finds the
// card's product on PriceCharting (or TCGplayer), logs today's market price in Canadian
// dollars, keeps the last month of those automatic entries, and downloads the product's
// high-resolution image. Entries the person logged themselves are never touched.

export interface UpdaterOptions {
  store: Store;
  assets: Assets;
  fetcher?: Fetcher;
  now?: () => Date;
  /** Calendar used for "today" and for the daily run time. */
  timeZone?: string;
  /** Hour of the day (0-23, in timeZone) after which the daily run starts. */
  hour?: number;
  /** Days of automatic price entries to keep. */
  keepDays?: number;
  /** Pause between cards, to be gentle with the price sites. */
  delayMs?: number;
  log?: Logger;
  /** Administrators' schedule (on/off and hour); overrides `hour` when given. */
  config?: Config;
  /** Consecutive failures from one site before the rest of the run stops asking it. */
  breakerAfter?: number;
  /** Fills cards' empty set, set code, rarity, illustrator and release date before pricing them (details.ts). */
  details?: CardDetails;
}

type Card = Doc & CardForMatch & {
  status?: string | null;
  prices?: PriceEntry[] | null;
  pricing?: Link | null;
  officialImageId?: string | null;
};
interface PriceEntry {
  id?: string;
  at?: string;
  type: string;
  amount: number;
  currency: string;
  date?: string;
  where?: string;
  note?: string;
  auto?: boolean | null;
  usd?: number | null;
}
interface Link {
  source: Source | 'none' | 'off';
  id?: string | null;
  url?: string | null;
  title?: string | null;
  set?: string | null;
  linkedBy?: 'auto' | 'user' | null;
  linkedAt?: string | null;
  imageUrl?: string | null;
  checkedAt?: string | null;
  error?: string | null;
  candidates?: Candidate[] | null;
}

/** Part of the error a card keeps while its site has no price for it (a person should pick another product). */
export const NO_PRICE = 'has no price for this printing';

export type CardOutcome = 'updated' | 'needsMatch' | 'noPrice' | 'failed' | 'skipped' | 'off';

export interface RunSummary {
  reason: 'schedule' | 'manual';
  date: string;
  startedAt: string;
  finishedAt: string;
  rate: number;
  rateDate: string | null;
  counts: Record<CardOutcome, number>;
  errors: { card: string; error: string }[];
}

const SOURCE_NAME: Record<Source, string> = { pricecharting: 'PriceCharting', tcgplayer: 'TCGplayer' };
const isLinked = (l: Link | null | undefined): l is Link & { source: Source; id: string } => !!l && (l.source === 'pricecharting' || l.source === 'tcgplayer') && !!l.id;
const label = (c: Card) => [c.name || 'Unnamed card', c.setCode || c.set, c.number].filter(Boolean).join(' ');
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
const round2 = (n: number) => Math.round(n * 100) / 100;
const foilWanted = (c: Card) => /reverse|foil/i.test(String(c.variant ?? ''));

export class PriceUpdater {
  private readonly store: Store;
  private readonly assets: Assets;
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  readonly timeZone: string;
  readonly hour: number;
  private readonly keepDays: number;
  private readonly delayMs: number;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<RunSummary> | null = null;
  private readonly log: Logger;
  private readonly config?: Config;
  private readonly breakerAfter: number;
  private readonly details?: CardDetails;

  constructor(o: UpdaterOptions) {
    this.store = o.store;
    this.assets = o.assets;
    this.fetcher = o.fetcher ?? fetch;
    this.now = o.now ?? (() => new Date());
    this.timeZone = o.timeZone ?? 'America/Vancouver';
    this.hour = o.hour ?? 5;
    this.keepDays = o.keepDays ?? 30;
    this.delayMs = o.delayMs ?? 2000;
    this.log = o.log ?? quietLogger();
    this.config = o.config;
    this.breakerAfter = o.breakerAfter ?? 5;
    this.details = o.details;
  }

  /** Whether the daily run is on, and its hour (administrators can change both). */
  schedule() {
    const c = this.config?.get().pricing;
    return { enabled: c?.enabled ?? true, hour: c?.hour ?? this.hour, timeZone: this.timeZone };
  }

  get running() {
    return !!this.current;
  }

  /** Today's date (YYYY-MM-DD) in the ledger's time zone. */
  today(at = this.now()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }

  private localHour(at = this.now()) {
    return Number(new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at));
  }

  private status(): Doc {
    return this.store.get('settings', 'pricing') ?? {};
  }

  private setStatus(patch: Doc) {
    this.store.set('settings', 'pricing', { ...this.status(), ...patch });
  }

  // ---- schedule --------------------------------------------------------------------

  /** Check every few minutes; run once a day after `hour`, including a day missed while the server was off. */
  startScheduler(everyMs = 10 * 60_000) {
    const tick = () => {
      const sch = this.schedule();
      if (!sch.enabled || this.running || this.localHour() < sch.hour) return;
      const last = this.status().lastRun as RunSummary | undefined;
      if (last?.date === this.today()) return;
      this.runAll('schedule').catch((err) => this.log.error('pricing', `Daily price update failed: ${message(err)}`));
    };
    this.timer = setInterval(tick, everyMs);
    this.timer.unref();
    setTimeout(tick, 30_000).unref();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- the daily run -----------------------------------------------------------------

  /** Update every card. A second call while one is running joins it. */
  runAll(reason: RunSummary['reason']): Promise<RunSummary> {
    this.current ??= this.doRunAll(reason).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async doRunAll(reason: RunSummary['reason']): Promise<RunSummary> {
    const startedAt = this.now().toISOString();
    const date = this.today();
    const ids = this.store.all().cards.map((c) => c.id);
    this.setStatus({ running: true, startedAt, done: 0, total: ids.length });
    const { rate, rateDate } = await this.rate();
    const counts: Record<CardOutcome, number> = { updated: 0, needsMatch: 0, noPrice: 0, failed: 0, skipped: 0, off: 0 };
    const errors: RunSummary['errors'] = [];
    let done = 0;
    // A site that keeps failing (down, or blocking us) is left alone for the rest of the run.
    const streak: Record<Source, number> = { pricecharting: 0, tcgplayer: 0 };
    const tripped = new Set<Source>();
    this.log.info('pricing', `Price update started (${reason}) for ${ids.length} cards at US$1 = C$${rate}`, { reason, cards: ids.length, rate });
    try {
      for (const id of ids) {
        const card = this.store.get('cards', id) as Card | undefined;
        let outcome: CardOutcome = 'skipped';
        if (card) {
          const src = isLinked(card.pricing) ? card.pricing.source : card.pricing?.source === 'off' ? null : 'pricecharting';
          try {
            if (src && tripped.has(src) && card.status !== 'sold' && card.status !== 'traded') {
              this.patchLink(id, { error: `Skipped: ${SOURCE_NAME[src]} kept failing during this update. It will be tried again next time.` });
              outcome = 'failed';
            } else {
              // Blanks first, release date included (it only asks TCGdex about cards with blanks, at
              // most once a week each): a known set helps find the right product.
              if (this.details) await this.details.fill(this.store, id).catch(() => {});
              outcome = await this.updateCard(id, rate);
            }
          } catch (err) {
            outcome = 'failed';
            this.log.error('pricing', `Price update for ${label(card)} failed: ${message(err)}`);
          }
          if (src && !tripped.has(src)) {
            if (outcome === 'failed') {
              if (++streak[src] >= this.breakerAfter) {
                tripped.add(src);
                this.log.warn('pricing', `${SOURCE_NAME[src]} failed ${streak[src]} times in a row; skipping it for the rest of this update`, { source: src });
              }
            } else if (outcome !== 'skipped' && outcome !== 'off') streak[src] = 0;
          }
          const after = this.store.get('cards', id) as Card | undefined;
          if (outcome === 'failed' || outcome === 'noPrice') errors.push({ card: label(card), error: after?.pricing?.error ?? 'Failed' });
        }
        counts[outcome]++;
        this.setStatus({ done: ++done });
        if (outcome !== 'skipped' && outcome !== 'off') await this.pause();
      }
    } finally {
      const summary: RunSummary = { reason, date, startedAt, finishedAt: this.now().toISOString(), rate, rateDate, counts, errors: errors.slice(0, 30) };
      const history = ((this.status().history as RunSummary[] | undefined) ?? []).slice(0, 29);
      this.setStatus({ running: false, lastRun: summary, history: [{ ...summary, errors: summary.errors.slice(0, 5) }, ...history] });
      const lvl = counts.failed ? 'warn' : 'info';
      this.log[lvl]('pricing', `Price update finished: ${counts.updated} updated, ${counts.needsMatch} need a match, ${counts.noPrice} without a price, ${counts.failed} failed`, { ...counts, tripped: [...tripped] });
    }
    return this.status().lastRun as RunSummary;
  }

  private pause() {
    return this.delayMs ? new Promise((r) => setTimeout(r, this.delayMs)) : Promise.resolve();
  }

  /** Today's Bank of Canada rate; if it can't be had, the last one saved. */
  private async rate(): Promise<{ rate: number; rateDate: string | null }> {
    const main = this.store.get('settings', 'main') ?? {};
    try {
      const { rate, date } = await usdToCad(this.fetcher);
      this.store.set('settings', 'main', { ...main, usdToCad: rate, usdToCadDate: date, usdToCadSource: 'Bank of Canada' });
      return { rate, rateDate: date };
    } catch (err) {
      this.log.warn('pricing', `Couldn't get the Bank of Canada rate, using the saved one: ${message(err)}`);
      return { rate: Number(main.usdToCad) > 0 ? Number(main.usdToCad) : 1.37, rateDate: (main.usdToCadDate as string) ?? null };
    }
  }

  // ---- one card ----------------------------------------------------------------------

  /** Find the card's product if needed, then log today's price and refresh its image. */
  async updateCard(id: string, rate?: number, rematched = false): Promise<CardOutcome> {
    let card = this.store.get('cards', id) as Card | undefined;
    if (!card) return 'skipped';
    if (card.pricing?.source === 'off') return 'off';
    if (card.status === 'sold' || card.status === 'traded') return 'skipped';
    const checkedAt = this.now().toISOString();

    if (!isLinked(card.pricing)) {
      let found: { match: Candidate | null; candidates: Candidate[] };
      try {
        found = await this.autoMatch(card);
      } catch (err) {
        this.patchLink(id, { error: message(err), checkedAt });
        return 'failed';
      }
      if (!found.match) {
        this.patchLink(id, { source: 'none', candidates: found.candidates, checkedAt, error: null }, true);
        return 'needsMatch';
      }
      const m = found.match;
      this.patchLink(id, { source: m.source, id: m.id, url: m.url, title: m.title, set: m.set, linkedBy: 'auto', linkedAt: checkedAt, candidates: null, error: null }, true);
      card = this.store.get('cards', id) as Card;
    }
    // Links saved from PriceCharting's search before its "&amp;" was decoded ("Scarlet &amp; Violet").
    if (card.pricing?.source === 'pricecharting' && pcPath(card.pricing.id!) !== card.pricing.id) {
      const path = pcPath(card.pricing.id!);
      this.patchLink(id, { id: path, url: `https://www.pricecharting.com${path}` });
      card = this.store.get('cards', id) as Card;
    }
    const link = card.pricing as Link & { source: Source; id: string };

    let quote: Quote;
    try {
      quote = link.source === 'pricecharting' ? await quotePriceCharting(this.fetcher, link.id) : await quoteTcgplayer(this.fetcher, link.id, foilWanted(card), !foilWanted(card) && /^(common|uncommon)$/i.test(String(card.rarity ?? '')));
    } catch (err) {
      // The product moved (renamed or merged on the site): match the card again, once.
      if (err instanceof ProductGone && !rematched) {
        this.log.warn('pricing', `${label(card)}: ${err.message} Matching it again.`);
        this.patchLink(id, { source: 'none', id: null, url: null, title: null, set: null, linkedBy: null, candidates: null, error: null }, true);
        return this.updateCard(id, rate, true);
      }
      this.patchLink(id, { error: message(err), checkedAt });
      return 'failed';
    }

    const fx = rate ?? (Number(this.store.get('settings', 'main')?.usdToCad) || 1.37);
    const image = await this.fetchImage(card, quote.image);

    // Network work is done: re-read the card so nothing the person changed meanwhile is lost.
    const fresh = this.store.get('cards', id) as Card | undefined;
    if (!fresh || !isLinked(fresh.pricing) || fresh.pricing.id !== link.id) return 'skipped';
    const date = this.today();
    const cutoff = this.today(new Date(Date.parse(`${date}T12:00:00Z`) - this.keepDays * 86_400_000));
    let prices = (fresh.prices ?? []).filter((p) => !(p.auto && (p.date === date || (p.date ?? '') < cutoff)));
    if (quote.usd != null) {
      prices = [
        ...prices,
        {
          id: rid(),
          at: checkedAt,
          type: 'market',
          amount: round2(quote.usd * fx),
          currency: 'CAD',
          date,
          where: SOURCE_NAME[link.source],
          note: `Daily update · US$${quote.usd.toFixed(2)} at ${fx.toFixed(4)}`,
          auto: true,
          usd: quote.usd,
        },
      ];
    }
    const oldImage = fresh.officialImageId;
    const patch: Doc = {
      prices,
      pricing: { ...fresh.pricing, checkedAt, error: quote.usd == null ? `${SOURCE_NAME[link.source]} ${NO_PRICE} of the card. If it's the wrong product, choose another.` : null, ...(image ? { imageUrl: image.url } : {}) },
      updatedAt: checkedAt,
    };
    if (image) patch.officialImageId = image.id;
    // The product's set, release date and rarity, for cards that lack them (or that the person
    // matched to a product from another set).
    if (quote.info) {
      const d = detailsFromProduct(fresh, quote.info, link.linkedBy === 'user');
      if (d.filled.length) {
        Object.assign(patch, d.patch);
        const was = d.patch.set && !String(fresh.set ?? '').trim() ? '' : d.patch.set ? ` (was ${fresh.set})` : '';
        this.log.info('pricing', `${label(fresh)}: ${d.filled.map((f) => `${f} ${d.patch[f]}`).join(', ')}${was} from ${SOURCE_NAME[link.source]}`);
      }
    }
    this.store.update('cards', id, patch);
    if (image && oldImage && oldImage !== image.id && !this.store.referencedImages().has(oldImage)) this.assets.remove(oldImage);
    return quote.usd == null ? 'noPrice' : 'updated';
  }

  /** Download the product image when the card has none yet or the match changed. */
  private async fetchImage(card: Card, url: string | null): Promise<{ id: string; url: string } | null> {
    if (!url) return null;
    if (card.officialImageId && card.pricing?.imageUrl === url && this.assets.find(card.officialImageId)) return null;
    try {
      const res = await get(this.fetcher, url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new SourceError('image too large');
      const saved = this.assets.put(buf);
      if (!saved) throw new SourceError("the image isn't a JPG, PNG, WebP or GIF");
      return { id: saved.id, url };
    } catch (err) {
      this.log.warn('pricing', `No new image for ${label(card)}: ${message(err)}`);
      return null;
    }
  }

  /** PriceCharting first; TCGplayer for cards PriceCharting doesn't list. */
  async autoMatch(card: CardForMatch): Promise<{ match: Candidate | null; candidates: Candidate[] }> {
    const q = searchQuery(card);
    const pc = chooseMatch(card, await searchPriceCharting(this.fetcher, q));
    if (pc.match) return pc;
    await this.pause();
    const tg = chooseMatch(card, await searchTcgplayer(this.fetcher, q).catch(() => []));
    if (tg.match) return tg;
    return { match: null, candidates: [...pc.candidates.slice(0, 5), ...tg.candidates.slice(0, 3)] };
  }

  /** Products the person can choose from, from both sites. */
  async search(card: CardForMatch, query?: string): Promise<Candidate[]> {
    const q = query?.trim() || searchQuery(card);
    const [pc, tg] = await Promise.all([searchPriceCharting(this.fetcher, q).catch(() => []), searchTcgplayer(this.fetcher, q).catch(() => [])]);
    const rank = (list: Candidate[]) => chooseMatch(card, list).candidates.concat(list).filter((c, i, a) => a.findIndex((x) => x.source === c.source && x.id === c.id) === i);
    return [...rank(pc).slice(0, 10), ...rank(tg).slice(0, 6)];
  }

  /** The person chose a product (or turned automatic pricing off, or back on). Updates the card straight away. */
  async link(id: string, choice: { source: 'off' | 'auto' } | Pick<Candidate, 'source' | 'id' | 'url' | 'title' | 'set'>): Promise<CardOutcome> {
    if (!this.store.get('cards', id)) throw new SourceError('No such card');
    const at = this.now().toISOString();
    if (choice.source === 'off') {
      this.patchLink(id, { source: 'off', checkedAt: at, error: null, candidates: null }, true);
      return 'off';
    }
    if (choice.source === 'auto') this.patchLink(id, { source: 'none', candidates: null, error: null }, true);
    else {
      const c = choice as Candidate;
      this.patchLink(id, { source: c.source, id: c.id, url: c.url, title: c.title, set: c.set, linkedBy: 'user', linkedAt: at, candidates: null, error: null }, true);
    }
    return this.updateCard(id);
  }

  /** Change the card's link. `replace` starts a fresh link; otherwise fields are merged into it. */
  private patchLink(id: string, link: Partial<Link>, replace = false) {
    const card = this.store.get('cards', id) as Card | undefined;
    if (!card) return;
    const base = replace ? { imageUrl: card.pricing?.imageUrl ?? null } : (card.pricing ?? { source: 'none' });
    this.store.update('cards', id, { pricing: { ...base, ...link } });
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
