import type { Assets } from '../assets';
import { MAX_IMAGE_BYTES } from '../assets';
import type { Config } from '../config';
import { type CardDetails, type DetailsStatus, checkIdentity } from '../details';
import { type Logger, quietLogger } from '../log';
import { type BlendSettings, blend } from '../blend';
import { safely } from '../recover';
import type { Doc } from '../schema';
import type { Store } from '../store';
import { Catalog, type CatalogQuote } from './catalog';
import { catalogMismatch, chooseMatch, detailsFromProduct, norm, otherBall, otherPrinting, searchQuery, variantFromProduct, type CardForMatch, type MatchResult } from './match';
import { type PcProduct, type PriceCharting, type PriceGuide, gradedPrice, oldAddress, quoteOf } from './pricecharting';
import { type TcgCsv, type TcgCsvCard, type TcgCsvQuote } from './tcgcsv';
import { type Candidate, type Fetcher, ProductGone, type Quote, Refused, type Source, SourceError, get, exchangeRates, tcgImage } from './sources';

// The daily price and image update. For every card still in the collection it finds the card's
// product on PriceCharting (through its API, pricecharting.ts) and the TCGplayer product the card
// databases name for it (catalog.ts), logs the highest of PriceCharting's ungraded price,
// TCGplayer's market price and Cardmarket's trend in Canadian dollars (a graded card: PriceCharting's
// price for its grade), keeps the last month of those automatic entries (and one a week before
// that, for the Pricing view's longer date ranges), and downloads the card's high-resolution
// picture. The card's main product (PriceCharting's when it has one) gives its details; the other
// site's product, its pair, only gives a price to compare. Entries the person logged themselves are
// never touched. No site's pages are read.

/** Monday of the week a YYYY-MM-DD date falls in. */
function weekOf(date: string): string {
  const t = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(t)) return '';
  const day = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The price log before today's automatic entry is added: today's earlier automatic entry is
 * dropped (it's replaced), automatic entries from `cutoff` on are all kept, and older ones are
 * thinned to the last one of each week. Entries the person logged are always kept.
 */
export function thinAutoPrices<P extends { auto?: boolean | null; date?: string | null }>(prices: P[], today: string, cutoff: string): P[] {
  const lastOfWeek = new Map<string, string>();
  for (const p of prices) {
    if (!p.auto || !p.date || p.date >= cutoff) continue;
    const w = weekOf(p.date);
    if (p.date > (lastOfWeek.get(w) ?? '')) lastOfWeek.set(w, p.date);
  }
  const kept = new Set<string>();
  return prices.filter((p) => {
    if (!p.auto) return true;
    if (!p.date || p.date === today) return false;
    if (p.date >= cutoff) return true;
    // one entry per week, even if two share that week's last date
    if (lastOfWeek.get(weekOf(p.date)) !== p.date || kept.has(p.date)) return false;
    kept.add(p.date);
    return true;
  });
}

export interface UpdaterOptions {
  store: Store;
  assets: Assets;
  fetcher?: Fetcher;
  now?: () => Date;
  /** Calendar used for "today" and for the daily run time. */
  timeZone?: string;
  /** Hour of the day (0-23, in timeZone) after which the daily run starts. */
  hour?: number;
  /** Days of daily automatic price entries to keep; older ones are thinned to one a week. */
  keepDays?: number;
  /** Pause between cards (each source also keeps its own pace). */
  delayMs?: number;
  log?: Logger;
  /** Administrators' schedule (on/off and hour); overrides `hour` when given. */
  config?: Config;
  /** Consecutive failures from one site before the rest of the run stops asking it. */
  breakerAfter?: number;
  /** Fills cards' empty set, set code, rarity, illustrator and release date before pricing them (details.ts). */
  details?: CardDetails;
  /** TCGplayer and Cardmarket prices and pictures from TCGdex (catalog.ts). */
  catalog?: Catalog;
  /** TCGplayer's own catalog (tcgcsv.ts), for what TCGdex doesn't have. */
  tcgcsv?: TcgCsv;
  /** PriceCharting's API (pricecharting.ts); without it, or without its token, PriceCharting isn't asked. */
  pricecharting?: PriceCharting;
  /** How long a run may go without finishing a card before it's flagged as stalled. */
  stallMs?: number;
}

/** What rebuilding the past daily prices changes (or changed). */
export interface RebuildSummary {
  method: string;
  /** Cards and daily prices that change. */
  cards: number;
  prices: number;
  /** The collection's value (each card held: its latest daily price, CAD) before and after. */
  valueBefore: number;
  valueAfter: number;
  /** The cards whose latest price changes most. */
  biggest: { card: string; before: number; after: number }[];
  /** The copy of the ledger taken first (Administration → Backups), when applied. */
  copy: string | null;
}

/**
 * An automatic daily price worked out again from `quotes` by `method`, at that day's own rate (its
 * CAD amount over its US$ price), with a note saying so; null when no source is left or the entry
 * has no US$ price to take the rate from.
 */
export function repriced<E extends { amount: number; usd?: number | null; where?: string; quotes?: Partial<Record<PriceSource, number>> | null; note?: string }>(
  e: E,
  quotes: Partial<Record<PriceSource, number>>,
  method: BlendSettings,
  why: string,
): E | null {
  const rate = Number(e.usd) > 0 ? e.amount / Number(e.usd) : null;
  const p = blend().price(quotes, method);
  if (!p || !rate) return null;
  return { ...e, quotes, usd: p.usd, where: p.where, amount: round2(p.usd * rate), note: `Daily update · ${p.summary} at ${rate.toFixed(4)} (${why})` };
}

/**
 * A card's prices disagree when one is more than 3 times another and they're at least US$5 apart
 * (cheap cards vary a lot in proportion): a sign one of its matches is the wrong card.
 */
export const DISAGREE = { ratio: 3, minUsd: 5 };
export function pricesDisagree(quotes: Partial<Record<string, number>>): boolean {
  const v = Object.values(quotes).filter((x): x is number => typeof x === 'number' && x > 0);
  if (v.length < 2) return false;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  return hi > lo * DISAGREE.ratio && hi - lo >= DISAGREE.minUsd;
}

type Card = Doc & CardForMatch & {
  status?: string | null;
  prices?: PriceEntry[] | null;
  pricing?: Link | null;
  officialImageId?: string | null;
  /** The person said the disagreeing prices are right, for these matches (Link.disagree.sig). */
  pricesDisagreeIgnored?: string | null;
  checksIgnored?: string | null;
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
  /** Each source's US-dollar price that day; `usd` is the highest. */
  quotes?: Partial<Record<PriceSource, number>> | null;
  /** A graded card's price: the PriceCharting grade it is ("PSA 10", "Grade 9"). */
  grade?: string | null;
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
  /** The card's product on the other site; the higher of the two sites' prices is logged. */
  pair?: Pair | null;
  /** The card's TCGdex id as last priced (catalog.ts). */
  catalog?: { tcgdexId?: string | null } | null;
}
/**
 * The card's product on the other price site. No `id`: that site was searched (at checkedAt)
 * without a certain match. `off`: the person said not to use that site for this card.
 */
interface Pair {
  source: Source;
  id?: string | null;
  url?: string | null;
  title?: string | null;
  set?: string | null;
  linkedBy?: 'auto' | 'user' | null;
  linkedAt?: string | null;
  off?: boolean | null;
  checkedAt?: string | null;
  error?: string | null;
}

/** Part of the error a card keeps while its site has no price for it (a person should pick another product). */
export const NO_PRICE = 'has no price for this printing';
/** Why PriceCharting isn't asked on a server without its API token. */
export const NO_TOKEN = "PriceCharting isn't set up: add its API token under Administration → Prices.";
/** A TCGplayer product the person chose that the card databases don't price (TCGplayer's own pages aren't read). */
const TCG_NOT_PRICED = "TCGplayer's prices come from the TCGdex card database, which doesn't price this TCGplayer product. Choose the product it names, or the card's PriceCharting product, with Change match.";

export type CardOutcome = 'updated' | 'needsMatch' | 'noPrice' | 'noPicture' | 'failed' | 'skipped' | 'off';

/**
 * What an update does to each card: `all` looks up its blank details, logs today's price and
 * downloads its picture (the daily update, and Update all cards → Everything, which also looks
 * cards up again that were looked up this week); `prices` only logs prices; `pictures` only
 * pictures the cards without an official picture or with a smaller one, and logs no price.
 */
export type RunScope = 'all' | 'prices' | 'pictures';
const RUN_NAME: Record<RunScope, string> = { all: 'price update', prices: 'price update', pictures: 'picture update' };
const runName = (scope: unknown) => RUN_NAME[(scope as RunScope) in RUN_NAME ? (scope as RunScope) : 'all'];
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
const zeroCounts = (): Record<CardOutcome, number> => ({ updated: 0, needsMatch: 0, noPrice: 0, noPicture: 0, failed: 0, skipped: 0, off: 0 });

export interface RunSummary {
  reason: 'schedule' | 'manual';
  /** What it updated (missing on runs from before there was a choice: they were `all`). */
  scope?: RunScope;
  date: string;
  startedAt: string;
  finishedAt: string;
  rate: number;
  rateDate: string | null;
  counts: Record<CardOutcome, number>;
  errors: { card: string; error: string }[];
  /** Sites that weren't used for (part of) the run, and why: they refused our requests or kept failing. */
  sitesOut?: Partial<Record<Source, string>>;
  /** A run that didn't get through every card, and how far it got. */
  ended?: 'interrupted' | 'stopped' | 'failed';
  done?: number;
  total?: number;
}

/**
 * Something that went wrong with an update: the server stopped or crashed during it, it stopped
 * making progress, or it failed partway. Kept in the status (so every page shows it, in red) until
 * someone dismisses it, even after a later update goes fine, so it isn't missed.
 */
export interface RunProblem {
  kind: 'interrupted' | 'stalled' | 'failed';
  title: string;
  message: string;
  /** When it was noticed. */
  at: string;
  /** The run it happened to (its log is the pricing log from then to `at`). */
  startedAt: string | null;
  reason: RunSummary['reason'] | null;
  done: number;
  total: number;
  /** The card it was on, and what it was doing. */
  card: string | null;
  step: string | null;
  /** The server was shut down on purpose (a restart or an update), so the daily run may start again. */
  graceful?: boolean;
  /** A stalled run that moved on, or a later update that went through every card. */
  recoveredAt?: string | null;
}

/** The site isn't being asked: PriceCharting without its token, or a site refusing or failing during this update. */
export class SiteOut extends SourceError {}

/** Where a price can come from: the two sites cards are matched on, and Cardmarket (through TCGdex). */
type PriceSource = Source | 'cardmarket';
const SOURCE_NAME: Record<PriceSource, string> = { pricecharting: 'PriceCharting', tcgplayer: 'TCGplayer', cardmarket: 'Cardmarket' };
const SOURCES: readonly string[] = ['pricecharting', 'tcgplayer'];
const isLinked = (l: Link | null | undefined): l is Link & { source: Source; id: string } => !!l && SOURCES.includes(l.source) && !!l.id;
/** A graded card (its grader and grade set): priced at PriceCharting's price for its grade. */
const isGraded = (c: Card) => !!c.grader && String(c.grader).trim() !== 'Raw' && !blank(c.grade);
const otherSite = (s: Source): Source => (s === 'pricecharting' ? 'tcgplayer' : 'pricecharting');
const pairLinked = (p: Pair | null | undefined): p is Pair & { id: string } => !!p && SOURCES.includes(p.source) && !!p.id && !p.off;
/** A pair the person decided on (chose it, or turned that site off), kept when the card is matched again. */
const keptPair = (p: Pair | null | undefined): Pair | null => (p && SOURCES.includes(p.source) && (p.off || (pairLinked(p) && p.linkedBy === 'user')) ? p : null);
/** Which product a link or pair is, without its card's state (error, candidates, image). */
const productOf = (l: { source: Source; id?: string | null; url?: string | null; title?: string | null; set?: string | null; linkedBy?: 'auto' | 'user' | null; linkedAt?: string | null }) => ({
  source: l.source,
  id: l.id ?? null,
  url: l.url ?? null,
  title: l.title ?? null,
  set: l.set ?? null,
  linkedBy: l.linkedBy ?? null,
  linkedAt: l.linkedAt ?? null,
});
/** Looking up cards (lookup.ts) asks PriceCharting only while the day's calls are under this share of its budget. */
export const LOOKUP_SHARE = 0.75;
/** How long before the other site is searched again for a card it had no certain match for. */
const PAIR_RETRY_MS = 7 * 86_400_000;
const label = (c: Card) => [c.name || 'Unnamed card', c.setCode || c.set, c.number].filter(Boolean).join(' ');
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
const round2 = (n: number) => Math.round(n * 100) / 100;
/** The TCGplayer product the card databases name for the card, as a certain match (catalog.ts). */
function catalogProduct(cat: CatalogQuote | null): Candidate | null {
  const id = cat?.tcgplayer?.productId;
  if (!cat || !id) return null;
  return { source: 'tcgplayer', id, url: `https://www.tcgplayer.com/product/${id}`, title: cat.name, set: cat.set, number: cat.number, usd: cat.tcgplayer!.usd, thumb: tcgImage(id, 200) };
}
/** The TCGplayer product TCGplayer's own catalog has for the card (tcgcsv.ts), as a certain match. */
function tcgcsvProduct(q: TcgCsvQuote | null): Candidate | null {
  if (!q) return null;
  return { source: 'tcgplayer', id: q.productId, url: q.url, title: q.name, set: q.set, number: q.number, usd: q.usd, thumb: tcgImage(q.productId, 200) };
}
/** The card's TCGdex id as kept on its link (catalog.ts). */
const catalogOf = (q: CatalogQuote) => ({ tcgdexId: q.tcgdexId });
const blank = (v: unknown) => v == null || String(v).trim() === '';

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
  private readonly catalog?: Catalog;
  private readonly tcgcsv?: TcgCsv;
  private readonly pc?: PriceCharting;
  /** The euro rate fetched for the current run (Cardmarket's prices are in euros). */
  private eur: number | null = null;
  /** During a run: each site's failures in a row, and the sites left alone for the rest of it (with why). */
  /** `force`: databases are asked again even about cards they were asked about this week (a manual run). */
  private run: { streak: Record<Source, number>; tripped: Map<Source, string>; scope: RunScope; force: boolean; guide: PriceGuide | null } | null = null;
  /** Which run is current: a stopped run's loop sees this change and ends without writing anything. */
  private gen = 0;
  private readonly stallMs: number;
  /** During a run: when the last card started, what it's doing now, and whether it's been flagged as stalled. */
  private progressAt = 0;
  private step: string | null = null;
  private stalled = false;
  private counts: Record<CardOutcome, number> | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(o: UpdaterOptions) {
    this.store = o.store;
    this.assets = o.assets;
    this.fetcher = o.fetcher ?? fetch;
    this.now = o.now ?? (() => new Date());
    this.timeZone = o.timeZone ?? 'America/Vancouver';
    this.hour = o.hour ?? 5;
    this.keepDays = o.keepDays ?? 30;
    // A short breath between cards: each source keeps its own pace (PriceCharting 1.25 s between
    // calls, tcgcsv.com ¼ s), and the price guide spares most
    // PriceCharting calls.
    this.delayMs = o.delayMs ?? 250;
    this.log = o.log ?? quietLogger();
    this.config = o.config;
    this.breakerAfter = o.breakerAfter ?? 5;
    this.details = o.details;
    this.catalog = o.catalog;
    this.tcgcsv = o.tcgcsv;
    this.pc = o.pricecharting;
    this.stallMs = o.stallMs ?? 10 * 60_000;
  }

  /** Whether the daily run is on, and its hour (administrators can change both); whether PriceCharting has its token. */
  schedule() {
    const c = this.config?.get().pricing;
    return { enabled: c?.enabled ?? true, hour: c?.hour ?? this.hour, timeZone: this.timeZone, pricecharting: !!this.pc?.ready, cardmarket: c?.cardmarket !== false, priceMethod: this.priceMethod() };
  }

  /**
   * Why a site isn't asked right now, or null when it is: PriceCharting without its API token, or
   * a site that refused our requests or kept failing during this update. TCGplayer's prices come
   * from the card databases, so it's never asked itself.
   */
  siteOut(src: Source): string | null {
    if (src === 'pricecharting' && !this.pc?.ready) return NO_TOKEN;
    // Cooling down after "too many requests", the breaker open, or today's call budget spent.
    const paused = src === 'pricecharting' ? this.pc?.out() : null;
    if (paused) return `${paused} TCGplayer and Cardmarket give prices meanwhile.`;
    return this.run?.tripped.get(src) ?? null;
  }

  /** How a card's daily price is worked out (blend.ts), as administrators set it. */
  priceMethod(): BlendSettings {
    return blend().settings(this.config?.get().priceMethod ?? null);
  }

  /**
   * Tell the page whether PriceCharting has its token, and how daily prices are worked out
   * (settings/pricing, which every page follows: Fix past daily prices uses the same method).
   */
  noteToken() {
    const priceMethod = this.priceMethod();
    if (this.status().pricecharting !== !!this.pc?.ready || JSON.stringify(this.status().priceMethod) !== JSON.stringify(priceMethod)) this.setStatus({ pricecharting: !!this.pc?.ready, priceMethod });
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
      if (!this.dueToday()) return;
      this.runAll('schedule').catch((err) => this.log.error('pricing', `Daily price update failed: ${message(err)}`));
    };
    const guarded = () => safely(this.log, 'pricing', 'Checking whether the daily price update is due', tick);
    this.timer = setInterval(guarded, everyMs);
    this.timer.unref();
    setTimeout(guarded, 30_000).unref();
  }

  /**
   * Whether the daily run hasn't happened yet today: no update finished today, and none started
   * today except one the server's restart cut short (that one starts again). One that crashed the
   * server or was stopped isn't started again by itself, so a run that crashes doesn't do it all day.
   */
  dueToday(): boolean {
    const st = this.status();
    if ((st.lastRun as RunSummary | undefined)?.date === this.today()) return false;
    // A picture update (kept in lastPictureRun) doesn't count: the day's prices are still to be logged.
    const startedAt = (st.pricesStartedAt ?? (st.scope === 'pictures' ? undefined : st.startedAt)) as string | undefined;
    if (!startedAt || this.today(new Date(startedAt)) !== this.today()) return true;
    const p = st.problem as RunProblem | null | undefined;
    return !!p && p.kind === 'interrupted' && !!p.graceful && p.startedAt === startedAt;
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- the daily run -----------------------------------------------------------------

  /** What the running update does, or null when none is running. */
  get runningScope(): RunScope | null {
    return this.current ? (this.run?.scope ?? 'all') : null;
  }

  /**
   * Update every card (`scope`: what to update; `force`: ask the databases again even about cards
   * they were asked about this week). A second call while one is running joins it.
   */
  runAll(reason: RunSummary['reason'], scope: RunScope = 'all', force = false): Promise<RunSummary> {
    if (!this.current) {
      const p: Promise<RunSummary> = this.doRunAll(reason, scope, force).finally(() => {
        if (this.current === p) this.current = null;
      });
      this.current = p;
    }
    return this.current;
  }

  private async doRunAll(reason: RunSummary['reason'], scope: RunScope = 'all', force = false): Promise<RunSummary> {
    const gen = ++this.gen;
    // False once the run is stopped (stop, shutdown): it then ends without writing anything.
    const live = () => this.gen === gen;
    const startedAt = this.now().toISOString();
    const date = this.today();
    const name = runName(scope);
    // A picture update only visits the cards that need one.
    const ids = this.store
      .all()
      .cards.filter((c) => scope !== 'pictures' || this.needsPicture(c as Card))
      .map((c) => c.id);
    this.setStatus({ running: true, startedAt, reason, scope, ...(scope === 'pictures' ? {} : { pricesStartedAt: startedAt }), done: 0, total: ids.length, current: null });
    this.progressAt = this.now().getTime();
    this.stalled = false;
    this.step = scope === 'pictures' ? null : 'getting the exchange rate from the Bank of Canada';
    const watchdog = (this.watchdog = setInterval(() => live() && safely(this.log, 'pricing', `Checking the ${name} for progress`, () => this.checkStall()), Math.min(30_000, Math.max(1000, this.stallMs / 4))));
    watchdog.unref();
    const { rate, rateDate } = scope === 'pictures' ? this.savedRate() : await this.rate();
    const counts = zeroCounts();
    this.counts = counts;
    const errors: RunSummary['errors'] = [];
    let done = 0;
    let failure: unknown = null;
    // A site that keeps failing (down, or refusing the token) is left alone for the rest of the run.
    this.catalog?.reset();
    this.tcgcsv?.reset();
    const run = (this.run = { streak: { pricecharting: 0, tcgplayer: 0 }, tripped: new Map<Source, string>(), scope, force, guide: null as PriceGuide | null });
    // PriceCharting's whole price guide in one call, instead of one call per card.
    if (scope !== 'pictures' && this.pc?.ready && !this.siteOut('pricecharting')) {
      this.step = "downloading PriceCharting's price guide";
      run.guide = await this.ask('pricecharting', () => this.pc!.priceGuide()).catch((err) => {
        this.log.warn('pricing', `Couldn't download PriceCharting's price guide, so each card is asked about on its own: ${message(err)}`);
        return null;
      });
    }
    this.log.info('pricing', `${capital(name)} started (${reason}${scope === 'all' ? '' : `, ${scope} only`}) for ${ids.length} cards${scope === 'pictures' ? '' : ` at US$1 = C$${rate}`}`, { reason, scope, cards: ids.length, rate });
    try {
      for (const id of ids) {
        if (!live()) break;
        const card = this.store.get('cards', id) as Card | undefined;
        let outcome: CardOutcome = 'skipped';
        if (card) {
          this.progress(label(card));
          try {
            if (scope === 'pictures') {
              outcome = await this.updatePicture(id);
            } else {
              // Blanks first, release date included (it only asks TCGdex about cards with blanks, at
              // most once a week each, unless the person asked for everything): a known set helps
              // find the right product.
              this.step = 'filling in its details from TCGdex';
              if (this.details && scope === 'all') await this.details.fill(this.store, id, run.force).catch(() => {});
              this.step = 'pricing it';
              outcome = await this.updateCard(id, rate);
            }
          } catch (err) {
            outcome = 'failed';
            this.log.error('pricing', `${capital(name)} for ${label(card)} failed: ${message(err)}`);
          }
          if (!live()) break;
          const after = this.store.get('cards', id) as Card | undefined;
          if (outcome === 'failed' || outcome === 'noPrice') errors.push({ card: label(card), error: after?.pricing?.error ?? 'Failed' });
          if (outcome === 'noPicture') errors.push({ card: label(card), error: 'No picture found in the card databases or on TCGplayer.' });
        }
        counts[outcome]++;
        this.setStatus({ done: ++done });
        if (outcome !== 'skipped' && outcome !== 'off') {
          this.step = 'pausing between cards';
          await this.pause();
        }
      }
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(watchdog);
    }
    const sitesOut: Partial<Record<Source, string>> = {};
    for (const [src, why] of run.tripped) sitesOut[src] = why;
    const summary: RunSummary = { reason, scope, date, startedAt, finishedAt: this.now().toISOString(), rate, rateDate, counts, errors: errors.slice(0, 30), ...(Object.keys(sitesOut).length ? { sitesOut } : {}) };
    // Stopped (or the server shutting down): stop() or shutdown() already wrote down how far it got.
    if (!live()) return { ...summary, ended: 'stopped', done, total: ids.length };
    this.run = null;
    this.eur = null;
    this.counts = null;
    const st = this.status();
    if (failure) {
      const at = this.now().toISOString();
      const card = (st.current as { card?: string } | null)?.card ?? null;
      const problem: RunProblem = {
        kind: 'failed',
        title: `The ${name} failed at card ${Math.min(done + 1, ids.length)} of ${ids.length}`,
        message: `It stopped with an error: ${message(failure)}. The cards before it were priced. Start it again; if it fails the same way, the log below shows where.`,
        at,
        startedAt,
        reason,
        done,
        total: ids.length,
        card,
        step: this.step,
      };
      this.log.error('pricing', `${capital(name)} failed after ${done} of ${ids.length} cards${card ? ` (on ${card})` : ''}: ${failure instanceof Error && failure.stack ? failure.stack : message(failure)}`, { done, total: ids.length });
      // A price update is written as the day's update so the daily run doesn't start it again and
      // again; the banner says what happened.
      const failed: RunSummary = { ...summary, ended: 'failed', done, total: ids.length };
      this.setStatus({ running: false, current: null, [scope === 'pictures' ? 'lastPictureRun' : 'lastRun']: failed, problem, history: this.withHistory(failed) });
      this.step = null;
      return failed;
    }
    const prior = st.problem as RunProblem | null | undefined;
    // An earlier problem stays shown (until dismissed), saying that this update went through.
    const problem = prior && !prior.recoveredAt ? { ...prior, recoveredAt: summary.finishedAt } : (prior ?? null);
    this.setStatus({ running: false, current: null, [scope === 'pictures' ? 'lastPictureRun' : 'lastRun']: summary, problem, history: this.withHistory(summary) });
    this.step = null;
    const lvl = counts.failed ? 'warn' : 'info';
    if (scope === 'pictures') this.log[lvl]('pricing', `Picture update finished: ${counts.updated} pictured, ${counts.noPicture} without a picture, ${counts.failed} failed`, { ...counts });
    else this.log[lvl]('pricing', `${capital(name)} finished${scope === 'prices' ? ' (prices only)' : ''}: ${counts.updated} updated, ${counts.needsMatch} need a match, ${counts.noPrice} without a price, ${counts.failed} failed`, { ...counts, tripped: [...run.tripped.keys()] });
    return summary;
  }

  /** The run history with a new run first (its error list shortened). */
  private withHistory(s: RunSummary): RunSummary[] {
    const history = ((this.status().history as RunSummary[] | undefined) ?? []).slice(0, 29);
    return [{ ...s, errors: s.errors.slice(0, 5) }, ...history];
  }

  /** A card started: progress, so the run isn't stalled (and if it had been, it moved on). */
  private progress(card: string) {
    this.progressAt = this.now().getTime();
    const patch: Doc = { current: { card, since: this.now().toISOString() } };
    if (this.stalled) {
      this.stalled = false;
      const p = this.status().problem as RunProblem | null | undefined;
      if (p?.kind === 'stalled' && p.startedAt === this.status().startedAt) {
        patch.problem = { ...p, recoveredAt: this.now().toISOString(), message: `${p.message} It moved on by itself afterwards.` };
        this.log.info('pricing', `Price update moved on after stalling on ${p.card ?? 'a card'}`);
      }
    }
    this.setStatus(patch);
  }

  /**
   * During a run, when no card has started for `stallMs` (a request that never ends, a site that
   * never answers): flag it as stalled, in the status and the log, naming the card and what it
   * was doing. Checked every half minute; it can then be stopped and started again.
   */
  checkStall(): RunProblem | null {
    if (!this.current || this.stalled) return null;
    const idleMs = this.now().getTime() - this.progressAt;
    if (idleMs < this.stallMs) return null;
    const st = this.status();
    const done = Number(st.done) || 0;
    const total = Number(st.total) || 0;
    const card = (st.current as { card?: string } | null)?.card ?? null;
    const mins = Math.round(idleMs / 60_000);
    this.stalled = true;
    const problem: RunProblem = {
      kind: 'stalled',
      title: `The ${runName(st.scope)} is stuck at card ${Math.min(done + 1, total)} of ${total}`,
      message: `Nothing has happened for ${mins} minute${mins === 1 ? '' : 's'}${card ? ` while ${this.step ?? 'pricing'} for ${card}` : this.step ? ` while ${this.step}` : ''}. Stop it and start it again; the log below shows its last steps.`,
      at: this.now().toISOString(),
      startedAt: (st.startedAt as string) ?? null,
      reason: (st.reason as RunSummary['reason']) ?? null,
      done,
      total,
      card,
      step: this.step,
    };
    this.log.error('pricing', `${capital(runName(st.scope))} stalled: no progress for ${mins} minutes at card ${Math.min(done + 1, total)} of ${total}${card ? ` (${card}, ${this.step ?? 'pricing'})` : ''}`, { done, total, card, step: this.step, minutes: mins });
    this.setStatus({ problem });
    return problem;
  }

  /**
   * Stop the running update: it's written down as stopped (with how far it got) straight away and
   * another can start, even while a request it's waiting on never ends; its loop sees it was
   * stopped and ends without writing anything else.
   */
  stop(by: string): boolean {
    if (!this.current) return false;
    const st = this.status();
    const p = st.problem as RunProblem | null | undefined;
    const wasStalled = this.stalled && p?.kind === 'stalled' && p.startedAt === st.startedAt;
    this.endRun('stopped');
    this.log.warn('pricing', `${by} stopped the ${runName(st.scope)} at ${st.done ?? 0} of ${st.total ?? 0} cards${wasStalled ? ' after it stalled' : ''}`);
    if (wasStalled) this.setStatus({ problem: { ...p, message: `${p.message} ${by} stopped it.` } });
    return true;
  }

  /** The server is shutting down (a restart or an update): a running update is written down as interrupted. */
  shutdown(why = 'The server was restarted or updated'): RunProblem | null {
    if (!this.current) return null;
    return this.interrupted(`${why} during the update.`, true);
  }

  /** The server crashed: a running update is written down as interrupted, with the error. */
  crashed(err: unknown): RunProblem | null {
    if (!this.current) return null;
    return this.interrupted(`The server crashed during the update: ${message(err)}.`, false);
  }

  /**
   * At startup: the saved status says an update is running, but this server just started, so the
   * last one stopped without saying (killed, out of memory, the machine restarted). It's written
   * down as interrupted, and Update all prices now works again.
   */
  recover(): RunProblem | null {
    const st = this.status();
    if (!st.running || this.current) return null;
    const problem = this.problemFor('interrupted', st, 'The server stopped unexpectedly during the update (it crashed, ran out of memory, or was killed).', false);
    const history = this.historyEntry(st, 'interrupted');
    this.setStatus({ running: false, current: null, problem, ...(history ? { history: this.withHistory(history) } : {}) });
    this.log.error('pricing', `${problem.title}: ${problem.message}`, { done: problem.done, total: problem.total, card: problem.card });
    return problem;
  }

  /** Hide the problem banner. */
  dismiss() {
    if (this.status().problem) this.setStatus({ problem: null });
  }

  private interrupted(why: string, graceful: boolean): RunProblem {
    const st = this.status();
    const problem = this.problemFor('interrupted', st, why, graceful);
    this.endRun('interrupted');
    this.setStatus({ problem });
    this.log.error('pricing', `${problem.title}: ${problem.message}`, { done: problem.done, total: problem.total, card: problem.card });
    return problem;
  }

  private problemFor(kind: RunProblem['kind'], st: Doc, why: string, graceful: boolean): RunProblem {
    const done = Number(st.done) || 0;
    const total = Number(st.total) || 0;
    const card = (st.current as { card?: string } | null)?.card ?? null;
    const step = this.current ? this.step : null;
    const at = Math.min(done + 1, total);
    return {
      kind,
      title: `The ${runName(st.scope)} was interrupted at card ${at} of ${total}`,
      message: `${why}${card ? (step ? ` It was ${step} for ${card}.` : ` It was on ${card}.`) : ''} ${done} card${done === 1 ? ' was' : 's were'} priced before that. ${graceful ? 'The daily update starts again by itself once the server is back, or start it again now.' : 'Start it again; the log below shows its last lines.'}`,
      at: this.now().toISOString(),
      startedAt: (st.startedAt as string) ?? null,
      reason: (st.reason as RunSummary['reason']) ?? null,
      done,
      total,
      card,
      step,
      ...(graceful ? { graceful: true } : {}),
    };
  }

  /** A history row for a run that didn't finish (from the saved status: its counts are only known while it runs). */
  private historyEntry(st: Doc, ended: RunSummary['ended']): RunSummary | null {
    const startedAt = st.startedAt as string | undefined;
    if (!startedAt) return null;
    const main = this.store.get('settings', 'main') ?? {};
    return {
      reason: (st.reason as RunSummary['reason']) ?? 'schedule',
      ...(st.scope ? { scope: st.scope as RunScope } : {}),
      date: this.today(new Date(startedAt)),
      startedAt,
      finishedAt: this.now().toISOString(),
      rate: Number(main.usdToCad) || 0,
      rateDate: (main.usdToCadDate as string) ?? null,
      counts: this.current && this.counts ? { ...this.counts } : zeroCounts(),
      errors: [],
      ended,
      done: Number(st.done) || 0,
      total: Number(st.total) || 0,
    };
  }

  /** End the running update now: its loop sees the change and ends without writing anything. */
  private endRun(ended: RunSummary['ended']) {
    const st = this.status();
    const history = this.historyEntry(st, ended);
    this.gen++;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.current = null;
    this.run = null;
    this.eur = null;
    this.counts = null;
    this.stalled = false;
    this.step = null;
    this.setStatus({ running: false, current: null, ...(history ? { history: this.withHistory(history) } : {}) });
  }

  /**
   * Ask a site something, unless it's out (siteOut). During a run, a site that fails
   * `breakerAfter` times in a row isn't asked again until the next one, and one that refuses our
   * requests isn't asked again at all. A site that answered, even "no such product", isn't failing.
   */
  private async ask<T>(src: Source, work: () => Promise<T>): Promise<T> {
    const out = this.siteOut(src);
    if (out) throw new SiteOut(out);
    const run = this.run;
    if (run) this.step = `asking ${SOURCE_NAME[src]}`;
    try {
      const result = await work();
      if (run) run.streak[src] = 0;
      return result;
    } catch (err) {
      if (err instanceof Refused) {
        const why = `${err.message} TCGplayer and Cardmarket gave prices meanwhile.`;
        if (run) run.tripped.set(src, why);
        this.log.warn('pricing', `${err.message}${run ? ' Not asking it again during this update.' : ''}`, { source: src });
      } else if (run && err instanceof ProductGone) run.streak[src] = 0;
      else if (run && !run.tripped.has(src) && ++run.streak[src] >= this.breakerAfter) {
        run.tripped.set(src, `Skipped: ${SOURCE_NAME[src]} kept failing during this update. It will be tried again next time.`);
        this.log.warn('pricing', `${SOURCE_NAME[src]} failed ${run.streak[src]} times in a row; skipping it for the rest of this update`, { source: src });
      }
      throw err;
    }
  }

  private pause() {
    return this.delayMs ? new Promise((r) => setTimeout(r, this.delayMs)) : Promise.resolve();
  }

  /** Today's Bank of Canada rates (US dollar, and euro for Cardmarket); if they can't be had, the last ones saved. */
  /** The rate the last update saved (a picture update doesn't need today's). */
  private savedRate(): { rate: number; rateDate: string | null } {
    const main = this.store.get('settings', 'main') ?? {};
    return { rate: Number(main.usdToCad) > 0 ? Number(main.usdToCad) : 1.37, rateDate: (main.usdToCadDate as string) ?? null };
  }

  private async rate(): Promise<{ rate: number; rateDate: string | null }> {
    const main = this.store.get('settings', 'main') ?? {};
    try {
      const { rate, eur, date } = await exchangeRates(this.fetcher);
      this.store.set('settings', 'main', { ...main, usdToCad: rate, usdToCadDate: date, usdToCadSource: 'Bank of Canada', ...(eur ? { eurToCad: eur } : {}) });
      this.eur = eur ?? (Number(main.eurToCad) > 0 ? Number(main.eurToCad) : null);
      return { rate, rateDate: date };
    } catch (err) {
      this.log.warn('pricing', `Couldn't get the Bank of Canada rate, using the saved one: ${message(err)}`);
      this.eur = Number(main.eurToCad) > 0 ? Number(main.eurToCad) : null;
      return { rate: Number(main.usdToCad) > 0 ? Number(main.usdToCad) : 1.37, rateDate: (main.usdToCadDate as string) ?? null };
    }
  }

  // ---- one card ----------------------------------------------------------------------

  /**
   * Find the card's products if needed, then log today's price (the highest of its sources) and
   * refresh its image. A card the card databases know (catalog.ts) is priced from them even while
   * it has no product on either site.
   */
  async updateCard(id: string, rate?: number, rematched = false): Promise<CardOutcome> {
    let card = this.store.get('cards', id) as Card | undefined;
    if (!card) return 'skipped';
    if (card.pricing?.source === 'off') return 'off';
    if (card.status === 'sold' || card.status === 'traded') return 'skipped';
    const checkedAt = this.now().toISOString();
    const cat = await this.catalogQuote(card);
    // TCGplayer's own catalog, for a TCGplayer price, product, picture or details the databases lack.
    const tcq = await this.tcgcsvQuote(card, cat);
    const eur = this.eur ?? (Number(this.store.get('settings', 'main')?.eurToCad) || null);
    const useCardmarket = this.schedule().cardmarket && !!eur;
    const catPriced = (!!cat && (!!cat.tcgplayer || (useCardmarket && cat.cardmarketEur != null))) || tcq?.usd != null;
    card = this.unlinkPlainProduct(id, card, cat);
    card = this.unlinkOtherPrinting(id, card);

    // Without a product yet: find one. If there's none, a card the databases price is still priced.
    let unmatched: CardOutcome | null = null;
    if (!isLinked(card.pricing)) {
      const kept = keptPair(card.pricing?.pair);
      if (pairLinked(kept)) {
        // The product the person chose on the other site stands in until the main one is found (findPair).
        this.store.update('cards', id, { pricing: { imageUrl: card.pricing?.imageUrl ?? null, catalog: card.pricing?.catalog ?? null, ...productOf(kept), candidates: null, error: null, pair: null } });
      } else {
        let found: Awaited<ReturnType<PriceUpdater['autoMatch']>> | null = null;
        try {
          found = await this.autoMatch(card, kept?.off ? [kept.source] : [], cat, tcq);
        } catch (err) {
          this.patchLink(id, { error: message(err), checkedAt });
          unmatched = 'failed';
        }
        if (found && !found.match) {
          this.patchLink(id, { source: 'none', candidates: found.candidates, checkedAt, error: null }, true);
          unmatched = 'needsMatch';
        } else if (found?.match) {
          this.patchLink(id, { ...productOf(found.match), linkedBy: 'auto', linkedAt: checkedAt, candidates: null, error: null, pair: kept ?? found.pair ?? null }, true);
        }
      }
      card = this.store.get('cards', id) as Card;
      if (unmatched && !catPriced) {
        if (cat) this.patchLink(id, { catalog: catalogOf(cat) });
        return unmatched;
      }
    }
    // PriceCharting products saved by their page address, before the binder used PriceCharting's API.
    const moved = await this.fromOldAddress(id);
    if (moved === 'gone' && !rematched) return this.updateCard(id, rate, true);
    await this.findPair(id, cat, tcq);
    card = this.store.get('cards', id) as Card;
    const link = isLinked(card.pricing) ? card.pricing : null;
    if (!link && !catPriced) return unmatched ?? 'skipped';
    const pair = link && pairLinked(link.pair) && link.pair.source !== link.source ? link.pair : null;

    // Both sites at once: the main product gives details too, the pair only its price. TCGplayer's
    // price is the card databases' price for the product they name (catalog.ts).
    const fromCatalog = (l: { id: string; linkedBy?: 'auto' | 'user' | null }) => !!cat?.tcgplayer && (cat.tcgplayer.productId ? cat.tcgplayer.productId === l.id : l.linkedBy !== 'user');
    const quote = (l: { source: Source; id: string; linkedBy?: 'auto' | 'user' | null }): Promise<Quote> => {
      if (l.source === 'pricecharting') {
        const known = (moved && typeof moved === 'object' && moved.id === l.id ? moved : null) ?? this.run?.guide?.get(l.id) ?? null;
        return known ? Promise.resolve(quoteOf(known)) : this.ask('pricecharting', () => this.pc!.product(l.id)).then(quoteOf);
      }
      if (fromCatalog(l)) return Promise.resolve({ usd: cat!.tcgplayer!.usd, image: tcgImage(l.id, 1000), info: null });
      // TCGplayer's own catalog prices the product the databases don't (its set name is TCGplayer's, so it isn't used).
      if (tcq?.productId === l.id && tcq.usd != null) return Promise.resolve({ usd: tcq.usd, image: tcgImage(l.id, 1000), info: { set: null, released: tcq.released, rarity: tcq.rarity } });
      return Promise.reject(new SourceError(cat ? TCG_NOT_PRICED : 'TCGplayer prices come from the TCGdex card database, which has no price for this card today.'));
    };
    const [mainQ, pairQ] = await Promise.allSettled([link ? quote(link) : Promise.resolve(null), pair ? quote(pair) : Promise.resolve(null)]);
    // The product is gone (renamed or merged on the site): match the card again, once.
    if (link && mainQ.status === 'rejected' && mainQ.reason instanceof ProductGone && !rematched) {
      this.log.warn('pricing', `${label(card)}: ${mainQ.reason.message} Matching it again.`);
      this.patchLink(id, { source: 'none', id: null, url: null, title: null, set: null, linkedBy: null, candidates: null, error: null }, true);
      return this.updateCard(id, rate, true);
    }
    const main = mainQ.status === 'fulfilled' ? mainQ.value : null;
    let mainError = mainQ.status === 'rejected' ? message(mainQ.reason) : null;
    const other = pairQ.status === 'fulfilled' ? pairQ.value : null;
    // A pair whose product is gone is looked for again next time.
    let pairPatch: Pair | null | undefined;
    if (pair) {
      if (pairQ.status === 'rejected') pairPatch = pairQ.reason instanceof ProductGone ? null : { ...pair, checkedAt, error: message(pairQ.reason) };
      else pairPatch = { ...pair, checkedAt, error: other?.usd == null ? `${SOURCE_NAME[pair.source]} ${NO_PRICE} of the card.` : null };
    }
    const withPair = pairPatch === undefined ? {} : { pair: pairPatch };
    const fx = rate ?? (Number(this.store.get('settings', 'main')?.usdToCad) || 1.37);

    // Each source's price; the highest is logged (the main site's on a tie).
    let quotes: Partial<Record<PriceSource, number>> = {};
    if (link && main?.usd != null) quotes[link.source] = main.usd;
    if (pair && other?.usd != null) quotes[pair.source] = other.usd;
    // The databases' TCGplayer price for a card with no TCGplayer product of its own (unless the
    // person turned TCGplayer off for it, or chose a product the databases don't name).
    const ownTcg = link?.source === 'tcgplayer' ? link : pair?.source === 'tcgplayer' ? pair : null;
    const tcgOff = link?.pair?.source === 'tcgplayer' && !!link.pair.off;
    if (cat?.tcgplayer && quotes.tcgplayer == null && !tcgOff && (!ownTcg || fromCatalog(ownTcg))) quotes.tcgplayer = cat.tcgplayer.usd;
    // Else TCGplayer's own catalog's price for the card's product (tcgcsv.ts).
    const tcgOffAny = tcgOff || (card.pricing?.pair?.source === 'tcgplayer' && !!card.pricing.pair.off);
    if (tcq?.usd != null && quotes.tcgplayer == null && !tcgOffAny && (!ownTcg || ownTcg.id === tcq.productId)) quotes.tcgplayer = tcq.usd;
    if (useCardmarket && cat?.cardmarketEur != null) quotes.cardmarket = round2((cat.cardmarketEur * eur!) / fx);
    // PriceCharting knows every set and variant; the card databases (TCGplayer's and Cardmarket's
    // prices) have subsets of them. Their prices count only when their card is PriceCharting's
    // product's set and printing; otherwise PriceCharting's price stands alone.
    const pcProduct = link?.source === 'pricecharting' ? link : pair?.source === 'pricecharting' ? pair : null;
    const mismatch = quotes.pricecharting != null && cat ? catalogMismatch(card, pcProduct, cat.set, (card.details as DetailsStatus | null | undefined)?.parentSet) : null;
    const leftOut = mismatch ? (['tcgplayer', 'cardmarket'] as const).filter((k) => quotes[k] != null) : [];
    for (const k of leftOut) delete quotes[k];
    // A graded card is worth PriceCharting's price for its grade (the others price raw cards). When
    // PriceCharting has no graded price for it, it gets the raw card's price, as before.
    const pcQuote = link?.source === 'pricecharting' ? main : pair?.source === 'pricecharting' ? other : null;
    // PriceCharting didn't answer (paused or failing): its graded price isn't known, so a graded card
    // keeps its last price instead of being logged at the raw card's.
    const pcAsked = link?.source === 'pricecharting' ? mainQ : pair?.source === 'pricecharting' ? pairQ : null;
    if (isGraded(card) && pcAsked?.status === 'rejected') {
      this.patchLink(id, { error: message(pcAsked.reason), checkedAt, ...withPair, ...(cat ? { catalog: catalogOf(cat) } : {}) });
      return 'failed';
    }
    // Likewise while PriceCharting is paused and the card has no product there to ask (one that
    // couldn't be looked for, or was just found gone and couldn't be matched again). Without a token
    // PriceCharting is never asked, so graded cards get the ungraded price as before.
    const pcOut = this.pc?.ready ? (this.pc.out() ?? this.run?.tripped.get('pricecharting') ?? null) : null;
    if (isGraded(card) && !pcProduct && pcOut) {
      this.patchLink(id, { error: `${pcOut} A graded card keeps its last price until PriceCharting answers.`, checkedAt, ...withPair, ...(cat ? { catalog: catalogOf(cat) } : {}) });
      return 'failed';
    }
    const graded = isGraded(card) ? gradedPrice(pcQuote?.grades, card.grader, card.grade) : null;
    if (graded) quotes = { pricecharting: graded.usd };
    // The day's price, by the chosen method (blend.ts): a blend of the sources by default, leaving
    // out one too far from PriceCharting's price. A graded card: PriceCharting's price for its grade.
    const picked = graded ? null : blend().price(quotes, this.priceMethod());
    const best: { usd: number; where: string; summary: string } | null = graded
      ? { usd: graded.usd, where: SOURCE_NAME.pricecharting, summary: '' }
      : picked && { usd: picked.usd, where: picked.where, summary: picked.summary };
    // Sources that disagree wildly usually mean one of the card's matches is another printing or
    // set (a reprint priced as its original): the card shows in Cards to check until its matches
    // change or the person says the prices are right.
    const sig = [link ? `${link.source}:${link.id}` : '', pair ? `${pair.source}:${pair.id}` : '', cat?.tcgdexId ?? ''].join('|');
    const disagree = !graded && pricesDisagree(quotes) && card.pricesDisagreeIgnored !== sig ? { quotes: { ...quotes }, sig, at: checkedAt } : null;
    if (disagree && best) {
      this.log.warn('pricing', `${label(card)}: its price sources disagree (${(Object.entries(quotes) as [PriceSource, number][]).map(([s, v]) => `${SOURCE_NAME[s]} US$${v.toFixed(2)}`).join(', ')}); logged ${best.where} US$${best.usd.toFixed(2)}. One of its matches may be another printing: see Cards to check.`, { quotes });
    }
    if (!best && unmatched) {
      if (cat) this.patchLink(id, { catalog: catalogOf(cat) });
      return unmatched;
    }
    if (!best && mainError && link) {
      this.patchLink(id, { error: mainError, checkedAt, ...withPair, ...(cat ? { catalog: catalogOf(cat) } : {}) });
      return 'failed';
    }
    // Priced from another source while PriceCharting is out: the update's summary says why, once.
    if (best && link && mainQ.status === 'rejected' && this.siteOut(link.source)) mainError = null;

    // A prices-only update leaves pictures alone.
    const image = this.run?.scope === 'prices' ? null : await this.fetchImage(card, this.pictureUrls(card, cat, link, pair, main?.image ?? null, tcq));

    // Network work is done: re-read the card so nothing the person changed meanwhile is lost.
    const fresh = this.store.get('cards', id) as Card | undefined;
    if (!fresh || fresh.pricing?.source === 'off') return 'skipped';
    if (link ? !isLinked(fresh.pricing) || fresh.pricing.id !== link.id : isLinked(fresh.pricing)) return 'skipped';
    const date = this.today();
    const cutoff = this.today(new Date(Date.parse(`${date}T12:00:00Z`) - this.keepDays * 86_400_000));
    let prices = thinAutoPrices(fresh.prices ?? [], date, cutoff);
    if (best) {
      const { usd, where } = best;
      const list = graded
        ? `PriceCharting's ${graded.label} price US$${usd.toFixed(2)}${graded.exact ? '' : ` (the nearest it has to ${String(card.grader).trim()} ${String(card.grade).trim()})`}`
        : best.summary;
      const ungraded = !isGraded(card) || graded ? '' : pcProduct ? ' · no graded price on PriceCharting, so the ungraded price' : ' · no PriceCharting product for its graded price, so the ungraded price';
      prices = [
        ...prices,
        {
          id: rid(),
          at: checkedAt,
          type: 'market',
          amount: round2(usd * fx),
          currency: 'CAD',
          date,
          where,
          note: `Daily update${cat?.variant ? ` (${cat.variant})` : ''} · ${list} at ${fx.toFixed(4)}${quotes.cardmarket != null ? ` (Cardmarket €${cat!.cardmarketEur!.toFixed(2)}, €1 = C$${eur!.toFixed(4)})` : ''}${leftOut.length ? ` · ${leftOut.map((k) => SOURCE_NAME[k]).join(' and ')} left out: ${mismatch}` : ''}${ungraded}`,
          auto: true,
          usd,
          quotes,
          ...(graded ? { grade: graded.label } : {}),
        },
      ];
    }
    const oldImage = fresh.officialImageId;
    const noPrice = link ? `${SOURCE_NAME[link.source]} ${NO_PRICE} of the card. If it's the wrong product, choose another.` : null;
    const patch: Doc = {
      prices,
      pricing: {
        ...(fresh.pricing ?? { source: 'none' }),
        checkedAt,
        error: link ? (mainError ?? (best ? null : noPrice)) : (fresh.pricing?.error ?? null),
        ...withPair,
        disagree,
        ...(image ? { imageUrl: image.url } : {}),
        ...(cat ? { catalog: catalogOf(cat) } : {}),
      },
      updatedAt: checkedAt,
    };
    if (image) patch.officialImageId = image.id;
    // The product's set (and release date, when PriceCharting gives one), for cards that lack them
    // (or that the person matched to a product from another set).
    if (link && main?.info) {
      const d = detailsFromProduct({ ...fresh, ...patch } as Card, main.info, link.linkedBy === 'user');
      if (d.filled.length) {
        Object.assign(patch, d.patch);
        const was = d.patch.set && !String(fresh.set ?? '').trim() ? '' : d.patch.set ? ` (was ${fresh.set})` : '';
        this.log.info('pricing', `${label(fresh)}: ${d.filled.map((f) => `${f} ${d.patch[f]}`).join(', ')}${was} from ${SOURCE_NAME[link.source]}`);
      }
    }
    // What's still blank (rarity, release date), from TCGplayer's own catalog.
    if (tcq && this.run?.scope !== 'prices') {
      const filled = (['rarity', 'released'] as const).filter((f) => blank(fresh[f]) && blank(patch[f]) && !blank(tcq[f]));
      for (const f of filled) patch[f] = tcq[f];
      if (filled.length) this.log.info('pricing', `${label(fresh)}: ${filled.map((f) => `${f} ${patch[f]}`).join(', ')} from TCGplayer`);
    }
    this.store.update('cards', id, patch);
    if (image && oldImage && oldImage !== image.id && !this.store.referencedImages().has(oldImage)) this.assets.remove(oldImage);
    return best ? 'updated' : 'noPrice';
  }

  /**
   * The pictures to try for a card, best first. A PriceCharting or pokemontcg.io picture the card
   * already has (from before pokemontcg.io was dropped) is kept: they're as large. Otherwise the
   * main product's, then the card's TCGplayer product's (717×1000: TCGdex has no pictures of some
   * sets, Trainer Galleries among them), then TCGdex's own (600×825), which the TCGplayer product's
   * replaces once there is one.
   */
  private pictureUrls(card: Card, cat: CatalogQuote | null, link: { source: string; id: string } | null, pair: { source: string; id: string } | null, mainImage: string | null, tcq: TcgCsvQuote | null = null): (string | null | undefined)[] {
    const current = card.officialImageId ? (card.pricing?.imageUrl ?? '') : '';
    if (/pricecharting/i.test(current)) return [];
    // A special variant (a Poké Ball pattern, say) is pictured by its own TCGplayer product, which shows it.
    if (cat?.special && link?.source === 'tcgplayer' && mainImage) return [mainImage];
    if (/pokemontcg\.io/i.test(current)) return [];
    const ownTcg = link?.source === 'tcgplayer' ? link : pair?.source === 'tcgplayer' ? pair : null;
    // The databases' product only for a plain printing (they sometimes name one product for several
    // special ones), else TCGplayer's own catalog's (which names its variant), and not when the
    // person turned TCGplayer off for the card.
    const off = card.pricing?.pair?.source === 'tcgplayer' && !!card.pricing.pair.off;
    const tcgId = ownTcg?.id ?? (off ? null : ((cat?.special ? null : cat?.tcgplayerProduct) ?? tcq?.productId ?? null));
    const tcgdexPicture = card.officialImageId ? null : (cat?.fallbackImage ?? null);
    return [mainImage, tcgId ? tcgImage(tcgId, 1000) : null, tcgdexPicture];
  }

  /** Whether a picture update should visit the card: it has no official picture, or TCGdex's smaller one. */
  needsPicture(c: Card): boolean {
    if (c.pricing?.source === 'off' || c.status === 'sold' || c.status === 'traded') return false;
    return !c.officialImageId || !this.assets.find(c.officialImageId) || /tcgdex/i.test(c.pricing?.imageUrl ?? '');
  }

  /**
   * Picture one card (a picture update): the best picture its TCGplayer product and TCGdex have, without logging a price. 'updated' when it got a new picture, 'noPicture' when it
   * still has none, 'skipped' when it keeps the one it has.
   */
  async updatePicture(id: string): Promise<CardOutcome> {
    const card = this.store.get('cards', id) as Card | undefined;
    if (!card) return 'skipped';
    if (card.pricing?.source === 'off') return 'off';
    if (card.status === 'sold' || card.status === 'traded') return 'skipped';
    const cat = await this.catalogQuote(card);
    const link = isLinked(card.pricing) ? card.pricing : null;
    const pair = link && pairLinked(link.pair) && link.pair.source !== link.source ? link.pair : null;
    const mainImage = link?.source === 'tcgplayer' ? tcgImage(link.id, 1000) : null;
    const tcq = await this.tcgcsvQuote(card, cat);
    const image = await this.fetchImage(card, this.pictureUrls(card, cat, link, pair, mainImage, tcq));
    // Network work is done: re-read the card so nothing the person changed meanwhile is lost.
    const fresh = this.store.get('cards', id) as Card | undefined;
    if (!fresh || fresh.pricing?.source === 'off') return 'skipped';
    const pricing = { ...(fresh.pricing ?? { source: 'none' }), ...(image ? { imageUrl: image.url } : {}), ...(cat ? { catalog: catalogOf(cat) } : {}) };
    if (image || cat) this.store.update('cards', id, { pricing, ...(image ? { officialImageId: image.id } : {}) });
    const oldImage = fresh.officialImageId;
    if (image && oldImage && oldImage !== image.id && !this.store.referencedImages().has(oldImage)) this.assets.remove(oldImage);
    return image ? 'updated' : fresh.officialImageId && this.assets.find(fresh.officialImageId) ? 'skipped' : 'noPicture';
  }

  /**
   * A PriceCharting product saved by its page address ("/game/pokemon-151/lapras-131", from before
   * the binder used the API) is moved to its API product id, found by searching for it. Returns the
   * product found (whose prices are then used), 'gone' when it wasn't found (the card is matched
   * again, keeping the person's other choices), or null when there was nothing to move or
   * PriceCharting couldn't be asked (it's tried again next time).
   */
  private async fromOldAddress(id: string): Promise<PcProduct | 'gone' | null> {
    const card = this.store.get('cards', id) as Card | undefined;
    const l = card?.pricing;
    if (!l || !this.pc) return null;
    const mainOld = l.source === 'pricecharting' && !!l.id && !!oldAddress(l.id);
    const pairOld = l.pair?.source === 'pricecharting' && !!l.pair.id && !!oldAddress(l.pair.id);
    if (!mainOld && !pairOld) return null;
    if (this.siteOut('pricecharting')) return null;
    const address = (mainOld ? l.id : l.pair!.id)!;
    let p: PcProduct | null;
    try {
      p = await this.ask('pricecharting', () => this.pc!.fromAddress(address));
    } catch (err) {
      this.log.warn('pricing', `${label(card!)}: couldn't find PriceCharting's ${address} in its API: ${message(err)}`);
      return null;
    }
    const fresh = this.store.get('cards', id) as Card | undefined;
    if (!fresh?.pricing) return null;
    const moved = p ? { id: p.id, url: p.url, title: p.title, set: p.set } : null;
    if (mainOld) {
      if (fresh.pricing.id !== address) return null;
      if (moved) this.patchLink(id, moved);
      else {
        this.log.info('pricing', `${label(fresh)}: PriceCharting's API has no product for ${address}; matching it again`);
        this.patchLink(id, { source: 'none', id: null, url: null, title: null, set: null, linkedBy: null, candidates: null, error: null }, true);
      }
    } else if (fresh.pricing.pair?.id === address) {
      this.patchLink(id, { pair: moved ? { ...fresh.pricing.pair, ...moved } : null });
    }
    return p ?? (mainOld ? 'gone' : null);
  }

  /**
   * A card automatically linked to the PriceCharting product of another plain printing or ball (a
   * Holo card to "[Reverse Holo]" or a Poké Ball card to "[Master Ball]", as matching once allowed,
   * or a card whose Variant was changed to Reverse Holo after it was matched to the plain product):
   * the link is dropped so its own product is found. Products the person chose stay.
   */
  private unlinkOtherPrinting(id: string, card: Card): Card {
    if (!card.pricing) return card;
    const wrong = (l: { source?: string; id?: string | null; title?: string | null; linkedBy?: string | null } | null | undefined) =>
      !!l && l.source === 'pricecharting' && !!l.id && l.linkedBy !== 'user' && (otherPrinting(card.variant, l.title) || otherBall(card.variant, l.title));
    if (wrong(card.pricing)) {
      this.log.info('pricing', `${label(card)}: was matched to PriceCharting's ${card.pricing.title}, another variant; matching it again`);
      this.patchLink(id, { source: 'none', id: null, url: null, title: null, set: null, linkedBy: null, candidates: null, error: null }, true);
    } else if (wrong(card.pricing.pair)) {
      this.log.info('pricing', `${label(card)}: its PriceCharting match ${card.pricing.pair!.title} was another variant; looking for its own product instead`);
      this.patchLink(id, { pair: null });
    } else return card;
    return this.store.get('cards', id) as Card;
  }

  /**
   * A card of a special variant (a Poké Ball pattern, a stamp, 1st Edition…) automatically linked to
   * the TCGplayer product of the plain card (as the databases named it before variants were read):
   * the link is dropped so the card's own product is found. Products the person chose stay.
   */
  private unlinkPlainProduct(id: string, card: Card, cat: CatalogQuote | null): Card {
    if (!cat?.special || !card.pricing) return card;
    const wrong = (l: { source?: string; id?: string | null; linkedBy?: string | null } | null | undefined) =>
      !!l && l.source === 'tcgplayer' && !!l.id && l.linkedBy !== 'user' && cat.plainProducts.includes(l.id) && l.id !== cat.tcgplayer?.productId;
    if (wrong(card.pricing)) {
      this.log.info('pricing', `${label(card)}: was matched to the regular card's TCGplayer product; matching its ${card.variant} variant instead`);
      this.patchLink(id, { source: 'none', id: null, url: null, title: null, set: null, linkedBy: null, candidates: null, error: null }, true);
    } else if (wrong(card.pricing.pair)) {
      this.log.info('pricing', `${label(card)}: its TCGplayer match was the regular card's product; looking for its ${card.variant} variant instead`);
      this.patchLink(id, { pair: null });
    } else return card;
    return this.store.get('cards', id) as Card;
  }

  /**
   * What TCGplayer's own catalog (tcgcsv.ts) says about an English card, when the card databases
   * left something for it to fill: a TCGplayer price, a picture, or a blank rarity or release date.
   * Null when it isn't certain which product the card is, or tcgcsv.com didn't answer.
   */
  private async tcgcsvQuote(card: Card, cat: CatalogQuote | null): Promise<TcgCsvQuote | null> {
    if (!this.tcgcsv || (!blank(card.language) && !/^en/i.test(String(card.language)))) return null;
    const l = card.pricing;
    const tcgOff = l?.pair?.source === 'tcgplayer' && !!l.pair.off;
    const own = l?.source === 'tcgplayer' && l.id ? l.id : l?.pair?.source === 'tcgplayer' && l.pair.id && !l.pair.off ? l.pair.id : null;
    const scope = this.run?.scope ?? 'all';
    const needPrice = scope !== 'pictures' && !tcgOff && !cat?.tcgplayer;
    const needPicture = scope !== 'prices' && !card.officialImageId;
    const needDetails = scope === 'all' && (blank(card.rarity) || blank(card.released));
    if (!needPrice && !needPicture && !needDetails) return null;
    const d = card.details as DetailsStatus | null | undefined;
    try {
      return await this.tcgcsv.quote(
        { name: card.name, set: card.set, setCode: card.setCode, number: card.number, variant: card.variant, rarity: card.rarity, tcgdexSet: cat?.set ?? (d as { set?: string } | null | undefined)?.set ?? null },
        own ?? cat?.tcgplayerProduct ?? null,
      );
    } catch (err) {
      this.log[this.run ? 'info' : 'warn']('pricing', `${label(card)}: tcgcsv.com: ${message(err)}`);
      return null;
    }
  }

  /** What the card databases say about the card today, or null when it isn't matched to TCGdex (or they didn't answer). */
  private async catalogQuote(card: Card): Promise<CatalogQuote | null> {
    const d = card.details as DetailsStatus | null | undefined;
    const tcgdexId = d?.id;
    if (!this.catalog || !tcgdexId) return null;
    // A TCGdex match from another set than the one the card is filed under (flagged in Cards to
    // check) gives no prices or picture until the person files it there, chooses it, or ignores the
    // check: a card that only shares a number would otherwise be priced as this one.
    if (d.filedUnder && norm(card.set) === norm(d.filedUnder.as) && !d.chosen && card.checksIgnored !== checkIdentity(card)) return null;
    if (this.run) this.step = 'asking the card database (TCGdex)';
    try {
      return await this.catalog.quote(tcgdexId, { variant: card.variant, rarity: card.rarity });
    } catch (err) {
      this.log.warn('pricing', `${label(card)}: no prices from TCGdex: ${message(err)}`);
      return null;
    }
  }

  /**
   * Find the card's product on its other site: TCGplayer's is the one the card databases name
   * (catalog.ts); PriceCharting's is searched for when it has never been looked for, or wasn't
   * found a week ago. A PriceCharting product found for a card matched on TCGplayer becomes its
   * main product (details come from PriceCharting); TCGplayer's becomes the pair.
   */
  private async findPair(id: string, cat: CatalogQuote | null = null, tcq: TcgCsvQuote | null = null): Promise<void> {
    const card = this.store.get('cards', id) as Card | undefined;
    if (!card || !isLinked(card.pricing)) return;
    const site = otherSite(card.pricing.source);
    const p = card.pricing.pair;
    if (site === 'tcgplayer') {
      const known = catalogProduct(cat) ?? tcgcsvProduct(tcq);
      // A product the person chose (or turning TCGplayer off) stands; an automatic match gives way to the databases'.
      if (known && !(p && p.source === site && (p.off || (p.id && (p.linkedBy === 'user' || p.id === known.id))))) {
        const at = this.now().toISOString();
        this.store.update('cards', id, { pricing: { ...card.pricing, pair: { ...productOf(known), linkedBy: 'auto', linkedAt: at, checkedAt: at } } });
      } else if (!known && cat && p?.source === site && p.id && !p.off && p.linkedBy !== 'user' && card.pricing.catalog?.tcgdexId && card.pricing.catalog.tcgdexId !== cat.tcgdexId) {
        // Matched to another TCGdex card since (a reprint that was taken for its original), which
        // names no TCGplayer product: the automatic one that came with the old match goes too.
        this.log.info('pricing', `${label(card)}: dropped TCGplayer's ${p.title ?? p.id}, which came with its earlier TCGdex match`);
        this.store.update('cards', id, { pricing: { ...card.pricing, pair: null } });
      }
      return;
    }
    if (this.siteOut(site)) return;
    if (p && p.source === site && (p.off || p.id || Date.parse(p.checkedAt ?? '') > this.now().getTime() - PAIR_RETRY_MS)) return;
    let list: Candidate[];
    try {
      list = await this.ask(site, () => this.pc!.search(searchQuery(card)));
    } catch (err) {
      this.log.warn('pricing', `Couldn't search ${SOURCE_NAME[site]} for ${label(card)}: ${message(err)}`);
      return; // looked for again next time
    }
    const at = this.now().toISOString();
    const m = chooseMatch(card, list).match;
    const fresh = this.store.get('cards', id) as Card | undefined;
    if (!fresh || !isLinked(fresh.pricing) || fresh.pricing.id !== card.pricing.id) return;
    if (m) {
      this.log.info('pricing', `${label(card)}: found on PriceCharting, which now gives its details; TCGplayer still gives a price`);
      this.store.update('cards', id, { pricing: { ...fresh.pricing, ...productOf(m), linkedBy: 'auto', linkedAt: at, pair: { ...productOf(fresh.pricing), checkedAt: at } } });
    } else {
      this.store.update('cards', id, { pricing: { ...fresh.pricing, pair: { source: site, id: null, checkedAt: at } } });
    }
  }

  /**
   * Download the first of `urls` (best first) that comes, when the card doesn't have it yet; one that
   * fails gives way to the next. Null when the card already has the best that comes, or none did.
   */
  private async fetchImage(card: Card, urls: (string | null | undefined)[]): Promise<{ id: string; url: string } | null> {
    const errors: string[] = [];
    for (const url of [...new Set(urls.filter((u): u is string => !!u))]) {
      if (card.officialImageId && card.pricing?.imageUrl === url && this.assets.find(card.officialImageId)) return null;
      if (this.run) this.step = 'downloading its picture';
      try {
        const res = await get(this.fetcher, url);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) throw new SourceError('image too large');
        const saved = this.assets.put(buf);
        if (!saved) throw new SourceError("the image isn't a JPG, PNG, WebP or GIF");
        if (errors.length) this.log.info('pricing', `${label(card)}: picture from ${new URL(url).host} (${errors.join('; ')})`);
        return { id: saved.id, url };
      } catch (err) {
        errors.push(`${new URL(url).host}: ${message(err)}`);
      }
    }
    if (errors.length) this.log.warn('pricing', `No new image for ${label(card)}: ${errors.join('; ')}`);
    return null;
  }

  /**
   * Find the card's products (except on a site in `skip`): PriceCharting's certain match from its
   * search, and the TCGplayer product the card databases name. The main product is PriceCharting's
   * when there is one; the other is its pair. PriceCharting failing for a moment leaves no pair, so
   * it's looked for again next time.
   */
  async autoMatch(card: CardForMatch, skip: Source[] = [], cat: CatalogQuote | null = null, tcq: TcgCsvQuote | null = null): Promise<{ match: Candidate | null; candidates: Candidate[]; pair?: Pair }> {
    const at = this.now().toISOString();
    const tg = skip.includes('tcgplayer') ? null : (catalogProduct(cat) ?? tcgcsvProduct(tcq));
    let pc: MatchResult | null = null;
    let pcError: unknown = null;
    if (!skip.includes('pricecharting')) {
      try {
        // The price guide's products with the card's number and name first; PriceCharting's search
        // when they don't give a certain match.
        const local = this.run?.guide ? chooseMatch(card, this.run.guide.candidates(card)) : null;
        pc = local?.match ? local : chooseMatch(card, await this.ask('pricecharting', () => this.pc!.search(searchQuery(card))));
      } catch (err) {
        pcError = err;
      }
    }
    if (pc?.match) return { ...pc, pair: tg ? { ...productOf(tg), linkedBy: 'auto', linkedAt: at, checkedAt: at } : undefined };
    if (tg) return { match: tg, candidates: [tg], pair: pc ? { source: 'pricecharting', id: null, checkedAt: at } : undefined };
    // Nothing to match it with. PriceCharting didn't answer: try again next time. It has no token:
    // there's nothing to choose from either, until it has one.
    if (pcError && !(pcError instanceof SiteOut && !this.pc?.ready)) throw pcError;
    return { match: null, candidates: (pc?.candidates ?? []).slice(0, 8) };
  }

  /** Products the person can choose from: PriceCharting's search, and the TCGplayer product the card databases name. */
  async search(card: CardForMatch, query?: string): Promise<Candidate[]> {
    const q = query?.trim() || searchQuery(card);
    const [pc, cat] = await Promise.all([this.ask('pricecharting', () => this.pc!.search(q)).catch(() => [] as Candidate[]), this.catalogQuote(card as Card)]);
    const ranked = chooseMatch(card, pc).candidates.concat(pc).filter((c, i, a) => a.findIndex((x) => x.id === c.id) === i);
    const known = catalogProduct(cat);
    return [...ranked.slice(0, 12), ...(known ? [known] : [])];
  }

  /**
   * PriceCharting's products for a search, for a card looked up without being in the ledger (Find
   * a card → Any card, lookup.ts). Throws why PriceCharting isn't asked (no token, paused, or the
   * day's calls past LOOKUP_SHARE of its budget, kept for the daily update) or its error. Not
   * counted against a running update's failures.
   */
  async lookupProducts(q: string): Promise<PcProduct[]> {
    const out = this.siteOut('pricecharting');
    if (out) throw new SiteOut(out);
    const use = this.pc!.usageNow();
    if (use.calls >= Math.floor(use.limit * LOOKUP_SHARE)) {
      throw new SiteOut(`today's PriceCharting calls (${use.calls} of ${use.limit}) are kept for the daily price update; looking cards up asks it again tomorrow.`);
    }
    return this.pc!.search(q);
  }

  /**
   * TCGplayer's own catalog (tcgcsv.ts) for a looked-up card's printing the card databases have no
   * TCGplayer price for, as the daily update asks it (tcgcsvQuote); null when it isn't found. Throws
   * when tcgcsv.com doesn't answer, so the card view can say so.
   */
  async lookupTcgplayer(card: TcgCsvCard, productId: string | null): Promise<TcgCsvQuote | null> {
    if (!this.tcgcsv) return null;
    return this.tcgcsv.quote(card, productId);
  }

  /** The exchange rates the last update saved: CAD per US dollar, and per euro when known. */
  savedRates(): { usd: number; eur: number | null } {
    const main = this.store.get('settings', 'main') ?? {};
    return { usd: this.savedRate().rate, eur: this.eur ?? (Number(main.eurToCad) > 0 ? Number(main.eurToCad) : null) };
  }

  /**
   * The owner's PriceCharting subscription ended: everything that came from PriceCharting is
   * removed, as its terms ask. Its products are unlinked (a card's TCGplayer product becomes its
   * main one), its prices are taken out of the daily entries (an entry it set is re-priced from the
   * other sources that day, or removed when there were none), its pictures are deleted (the next
   * update downloads others) and the token is forgotten. Prices people logged themselves stay.
   */
  /**
   * Work every card's past automatic daily prices out again with the current price method, from
   * the sources' prices each one kept, at its own day's rate. Graded prices (PriceCharting's for
   * the grade) and entries from before each source's price was kept are left as they are. With
   * `apply`, saves them (call `beforeApply` first to keep a copy of the ledger); otherwise only
   * says what would change.
   */
  rebuildPrices(apply: boolean, beforeApply?: () => string | null): RebuildSummary {
    if (apply && this.running) throw new SourceError('A price update is running. Try again when it has finished.');
    const method = this.priceMethod();
    const name = blend().METHODS[method.method];
    const out: RebuildSummary = { method: method.method, cards: 0, prices: 0, valueBefore: 0, valueAfter: 0, biggest: [], copy: null };
    const patches: { id: string; patch: Doc }[] = [];
    const latest = (list: PriceEntry[]) => list.filter((e) => e.auto && e.date).sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0))[0];
    for (const c of this.store.all().cards as (Card & { id: string; placeholder?: boolean | null })[]) {
      const prices = c.prices ?? [];
      let changed = 0;
      // The card databases' prices that aren't this card's (another set or printing than its
      // PriceCharting product) are left out of every day, as the daily update does now.
      const l = c.pricing;
      const pcProduct = l && l.source === 'pricecharting' ? l : l?.pair && l.pair.source === 'pricecharting' && !l.pair.off ? l.pair : null;
      const d = c.details as DetailsStatus | null | undefined;
      const mismatch = catalogMismatch(c, pcProduct, d?.set, d?.parentSet);
      const next = prices.map((e) => {
        let quotes = e.quotes && typeof e.quotes === 'object' ? e.quotes : null;
        if (!e.auto || e.grade || !quotes || !Object.values(quotes).some((v) => typeof v === 'number' && v > 0)) return e;
        if (mismatch && quotes.pricecharting != null) quotes = { pricecharting: quotes.pricecharting };
        const again = repriced(e, quotes, method, `rebuilt: ${name}${mismatch && Object.keys(e.quotes!).length > 1 ? `; TCGplayer and Cardmarket left out: ${mismatch}` : ''}`);
        if (!again || Math.abs(again.amount - e.amount) < 0.005) return e;
        changed++;
        return again;
      });
      const counts = c.status !== 'sold' && c.status !== 'traded' && !c.placeholder;
      const [before, after] = [latest(prices), latest(next)];
      if (counts) {
        out.valueBefore += before?.amount ?? 0;
        out.valueAfter += after?.amount ?? 0;
      }
      if (!changed) continue;
      out.cards++;
      out.prices += changed;
      if (before && after && before.amount !== after.amount) out.biggest.push({ card: label(c), before: before.amount, after: after.amount });
      patches.push({ id: c.id, patch: { prices: next } });
    }
    out.valueBefore = round2(out.valueBefore);
    out.valueAfter = round2(out.valueAfter);
    out.biggest = out.biggest.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 8);
    if (apply && patches.length) {
      out.copy = beforeApply?.() ?? null;
      this.store.updateMany('cards', patches);
      this.log.info('pricing', `Past daily prices rebuilt (${name}): ${out.prices} prices on ${out.cards} cards; collection value C$${out.valueBefore.toFixed(2)} → C$${out.valueAfter.toFixed(2)}`, { ...out, biggest: undefined });
    }
    return out;
  }

  purgePriceCharting(forget: () => void): { cards: number; prices: number; removed: number; pictures: number } {
    if (this.running) throw new SourceError('A price update is running. Try again when it has finished.');
    forget();
    const method = this.priceMethod();
    const out = { cards: 0, prices: 0, removed: 0, pictures: 0 };
    const pictures: string[] = [];
    const patches: { id: string; patch: Doc }[] = [];
    for (const c of this.store.all().cards as (Card & { id: string })[]) {
      const patch: Doc = {};
      const l = c.pricing;
      if (l) {
        let next: Link = { ...l };
        if (next.source === 'pricecharting') {
          next = pairLinked(l.pair)
            ? { ...next, ...productOf(l.pair), pair: null }
            : { ...next, source: 'none', id: null, url: null, title: null, set: null, linkedBy: null, linkedAt: null, pair: l.pair?.source === 'tcgplayer' ? l.pair : null };
        }
        if (next.pair?.source === 'pricecharting') next.pair = null;
        if (next.candidates?.some((x) => x.source === 'pricecharting')) next.candidates = next.candidates.filter((x) => x.source !== 'pricecharting');
        if (next.error && /pricecharting/i.test(next.error)) next.error = null;
        if (/pricecharting/i.test(l.imageUrl ?? '') && c.officialImageId) {
          pictures.push(c.officialImageId);
          patch.officialImageId = null;
          next.imageUrl = null;
          out.pictures++;
        }
        if (JSON.stringify(next) !== JSON.stringify(l)) patch.pricing = next;
      }
      const prices = c.prices ?? [];
      let changed = 0;
      const kept = prices.flatMap((e) => {
        if (!e.auto || (e.quotes?.pricecharting == null && e.where !== 'PriceCharting')) return [e];
        changed++;
        const { pricecharting: _, ...rest } = e.quotes ?? {};
        // Another source's price alone: it stays, without PriceCharting's in its note.
        if (e.where !== 'PriceCharting' && e.where !== 'Blend') return [{ ...e, quotes: rest, note: e.usd != null ? `Daily update · ${e.where ?? 'Market'} US$${Number(e.usd).toFixed(2)} (PriceCharting's price removed)` : undefined }];
        // PriceCharting set this entry, or was part of its blend: worked out again from the day's
        // other prices, at the same rate (a graded price was PriceCharting's alone, so it goes).
        if (e.grade) return [];
        const again = repriced(e, rest, method, "PriceCharting's price removed");
        return again ? [again] : [];
      });
      if (changed) {
        patch.prices = kept;
        out.prices += changed;
        out.removed += prices.length - kept.length;
      }
      if (Object.keys(patch).length) {
        patches.push({ id: c.id, patch });
        out.cards++;
      }
    }
    this.store.updateMany('cards', patches);
    const used = this.store.referencedImages();
    for (const img of pictures) if (!used.has(img)) this.assets.remove(img);
    this.noteToken();
    this.log.info('pricing', `PriceCharting's data purged: ${out.cards} cards, ${out.prices} daily prices (${out.removed} removed), ${out.pictures} pictures`, out);
    return out;
  }

  /**
   * The person chose a product (or turned automatic pricing off, or back on, or stopped or
   * restarted using the card's other site). Updates the card straight away. A product chosen on
   * the card's other site becomes its pair; PriceCharting's, when chosen, is always the main one.
   */
  async link(id: string, choice: { source: 'off' | 'auto' } | { pair: 'off' | 'auto' } | Pick<Candidate, 'source' | 'id' | 'url' | 'title' | 'set'>): Promise<CardOutcome> {
    const card = this.store.get('cards', id) as Card | undefined;
    if (!card) throw new SourceError('No such card');
    const at = this.now().toISOString();
    if ('pair' in choice) {
      if (!isLinked(card.pricing)) throw new SourceError('Match the card on one site first');
      this.patchLink(id, { pair: choice.pair === 'off' ? { source: otherSite(card.pricing.source), off: true, checkedAt: at } : null });
      return this.updateCard(id);
    }
    if (choice.source === 'off') {
      this.patchLink(id, { source: 'off', checkedAt: at, error: null, candidates: null }, true);
      return 'off';
    }
    if (choice.source === 'auto') {
      this.patchLink(id, { source: 'none', candidates: null, error: null }, true);
      return this.updateCard(id);
    }
    const c = choice as Candidate;
    const p = card.pricing;
    const links: Partial<Record<Source, Pair | null>> = {};
    if (p?.pair && SOURCES.includes(p.pair.source)) links[p.pair.source] = p.pair;
    if (isLinked(p)) links[p.source] = productOf(p);
    const before = links[c.source];
    links[c.source] = { ...productOf(c), linkedBy: 'user', linkedAt: at };
    // Correcting a match: the other site's automatic match was for the old product, so it's looked for again.
    const o = otherSite(c.source);
    if (pairLinked(before) && before.id !== c.id && links[o] && !keptPair(links[o])) links[o] = null;
    const mainSite: Source = pairLinked(links.pricecharting) ? 'pricecharting' : c.source;
    const mainLink = links[mainSite] as Pair;
    // The person said this product is their card, so a variant in its title is the card's variant.
    const variant = variantFromProduct(card, c.title);
    if (variant) this.log.info('pricing', `${label(card)}: variant ${variant}${String(card.variant ?? '').trim() ? ` (was ${card.variant})` : ''} from ${SOURCE_NAME[c.source]}`);
    this.store.update('cards', id, { pricing: { imageUrl: p?.imageUrl ?? null, ...productOf(mainLink), candidates: null, error: null, pair: links[otherSite(mainSite)] ?? null }, ...(variant ? { variant } : {}) });
    return this.updateCard(id);
  }

  /** Change the card's link. `replace` starts a fresh link (keeping a pair the person decided on); otherwise fields are merged into it. */
  private patchLink(id: string, link: Partial<Link>, replace = false) {
    const card = this.store.get('cards', id) as Card | undefined;
    if (!card) return;
    const base = replace ? { imageUrl: card.pricing?.imageUrl ?? null, catalog: card.pricing?.catalog ?? null, pair: keptPair(card.pricing?.pair) } : (card.pricing ?? { source: 'none' });
    this.store.update('cards', id, { pricing: { ...base, ...link } });
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
