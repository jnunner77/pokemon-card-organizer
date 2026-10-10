import type { Assets } from '../assets';
import { MAX_IMAGE_BYTES } from '../assets';
import type { Config } from '../config';
import type { CardDetails } from '../details';
import { type Logger, quietLogger } from '../log';
import type { Doc } from '../schema';
import type { Store } from '../store';
import { Catalog, type CatalogQuote, printingOf } from './catalog';
import { chooseMatch, detailsFromProduct, searchQuery, setSearchQuery, variantFromProduct, type CardForMatch, type MatchResult } from './match';
import {
  type Candidate,
  type Fetcher,
  ProductGone,
  type Quote,
  Refused,
  type Source,
  SourceError,
  get,
  pcPath,
  quotePriceCharting,
  quoteTcgplayer,
  searchPriceCharting,
  searchTcgplayer,
  exchangeRates,
  tcgImage,
} from './sources';

// The daily price and image update. For every card still in the collection it finds the
// card's product on PriceCharting and on TCGplayer, reads its prices from the card databases'
// APIs (catalog.ts: TCGplayer's market price and Cardmarket's trend, through TCGdex), logs the
// highest of all those prices in Canadian dollars, keeps the last month of those automatic entries (and one a week
// before that, for the Pricing view's longer date ranges), and downloads the product's
// high-resolution image. The card's main product (PriceCharting's when it has one) gives its
// details and image; the other site's product, its pair, only gives a price to compare. Entries
// the person logged themselves are never touched.

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
  /** Pause between cards, to be gentle with the price sites. */
  delayMs?: number;
  log?: Logger;
  /** Administrators' schedule (on/off and hour); overrides `hour` when given. */
  config?: Config;
  /** Consecutive failures from one site before the rest of the run stops asking it. */
  breakerAfter?: number;
  /** Fills cards' empty set, set code, rarity, illustrator and release date before pricing them (details.ts). */
  details?: CardDetails;
  /** TCGplayer and Cardmarket prices and large pictures from TCGdex and pokemontcg.io (catalog.ts). */
  catalog?: Catalog;
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
  /** Each source's US-dollar price that day; `usd` is the highest. */
  quotes?: Partial<Record<PriceSource, number>> | null;
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
  /** The card's ids in the card databases (catalog.ts): TCGdex's, and pokemontcg.io's or when it was last looked for there. */
  catalog?: { tcgdexId?: string | null; ptcgId?: string | null; ptcgSearchedAt?: string | null } | null;
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
  /** Sites that weren't used for (part of) the run, and why: turned off, refused our requests or kept failing. */
  sitesOut?: Partial<Record<Source, string>>;
}

/** The site isn't being asked: turned off under Administration → Prices, or refusing or failing during this update. */
export class SiteOut extends SourceError {}
/** How long a site that refused our requests is left alone between updates (each update asks it once more). */
const REFUSED_MS = 60 * 60_000;

/** Where a price can come from: the two sites cards are matched on, and Cardmarket (through TCGdex). */
type PriceSource = Source | 'cardmarket';
const SOURCE_NAME: Record<PriceSource, string> = { pricecharting: 'PriceCharting', tcgplayer: 'TCGplayer', cardmarket: 'Cardmarket' };
const SOURCES: readonly string[] = ['pricecharting', 'tcgplayer'];
const isLinked = (l: Link | null | undefined): l is Link & { source: Source; id: string } => !!l && SOURCES.includes(l.source) && !!l.id;
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
/** The card's database ids as kept on its link (catalog.ts). */
const catalogOf = (q: CatalogQuote) => ({ tcgdexId: q.tcgdexId, ptcgId: q.ptcgId, ptcgSearchedAt: q.ptcgSearchedAt });
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
  private readonly catalog?: Catalog;
  /** The euro rate fetched for the current run (Cardmarket's prices are in euros). */
  private eur: number | null = null;
  /** During a run: each site's failures in a row, and the sites left alone for the rest of it (with why). */
  private run: { streak: Record<Source, number>; tripped: Map<Source, string> } | null = null;
  /** When each site last refused our requests (401/403), outside or during a run. */
  private refused = new Map<Source, { at: number; why: string }>();

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
    this.catalog = o.catalog;
  }

  /** Whether the daily run is on, and its hour (administrators can change both). */
  schedule() {
    const c = this.config?.get().pricing;
    return { enabled: c?.enabled ?? true, hour: c?.hour ?? this.hour, timeZone: this.timeZone, pricecharting: c?.pricecharting !== false, cardmarket: c?.cardmarket !== false };
  }

  /**
   * Why a site isn't asked right now, or null when it is: PriceCharting turned off by the
   * administrators, or a site that refused our requests in the last hour or that kept failing
   * during this update. Nothing tries to get round a refusal; TCGplayer stands in meanwhile.
   */
  siteOut(src: Source): string | null {
    if (src === 'pricecharting' && !this.schedule().pricecharting) return 'PriceCharting is turned off under Administration → Prices.';
    const tripped = this.run?.tripped.get(src);
    if (tripped) return tripped;
    const r = this.refused.get(src);
    return r && r.at > this.now().getTime() - REFUSED_MS ? r.why : null;
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
    // A site that keeps failing (down, or blocking us) is left alone for the rest of the run. One
    // that refused us earlier is asked once more: it may have let us back in.
    this.refused.clear();
    this.catalog?.reset();
    const run = (this.run = { streak: { pricecharting: 0, tcgplayer: 0 }, tripped: new Map<Source, string>() });
    this.log.info('pricing', `Price update started (${reason}) for ${ids.length} cards at US$1 = C$${rate}`, { reason, cards: ids.length, rate });
    try {
      for (const id of ids) {
        const card = this.store.get('cards', id) as Card | undefined;
        let outcome: CardOutcome = 'skipped';
        if (card) {
          try {
            // Blanks first, release date included (it only asks TCGdex about cards with blanks, at
            // most once a week each): a known set helps find the right product.
            if (this.details) await this.details.fill(this.store, id).catch(() => {});
            outcome = await this.updateCard(id, rate);
          } catch (err) {
            outcome = 'failed';
            this.log.error('pricing', `Price update for ${label(card)} failed: ${message(err)}`);
          }
          const after = this.store.get('cards', id) as Card | undefined;
          if (outcome === 'failed' || outcome === 'noPrice') errors.push({ card: label(card), error: after?.pricing?.error ?? 'Failed' });
        }
        counts[outcome]++;
        this.setStatus({ done: ++done });
        if (outcome !== 'skipped' && outcome !== 'off') await this.pause();
      }
    } finally {
      const sitesOut: Partial<Record<Source, string>> = {};
      for (const src of SOURCES as Source[]) {
        const why = this.siteOut(src);
        if (why) sitesOut[src] = why;
      }
      this.run = null;
      this.eur = null;
      const summary: RunSummary = { reason, date, startedAt, finishedAt: this.now().toISOString(), rate, rateDate, counts, errors: errors.slice(0, 30), ...(Object.keys(sitesOut).length ? { sitesOut } : {}) };
      const history = ((this.status().history as RunSummary[] | undefined) ?? []).slice(0, 29);
      this.setStatus({ running: false, lastRun: summary, history: [{ ...summary, errors: summary.errors.slice(0, 5) }, ...history] });
      const lvl = counts.failed ? 'warn' : 'info';
      this.log[lvl]('pricing', `Price update finished: ${counts.updated} updated, ${counts.needsMatch} need a match, ${counts.noPrice} without a price, ${counts.failed} failed`, { ...counts, tripped: [...run.tripped.keys()] });
    }
    return this.status().lastRun as RunSummary;
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
    try {
      const result = await work();
      if (run) run.streak[src] = 0;
      return result;
    } catch (err) {
      if (err instanceof Refused) {
        const why = `${SOURCE_NAME[src]} refused the binder's requests (${err.message.match(/\d{3}/)?.[0] ?? 'refused'}); ${src === 'pricecharting' ? 'TCGplayer and Cardmarket give prices meanwhile' : 'it will be asked again next update'}.`;
        this.refused.set(src, { at: this.now().getTime(), why });
        if (run) run.tripped.set(src, why);
        this.log.warn('pricing', `${why} Not asking it again ${run ? 'during this update' : 'for an hour'}.`, { source: src });
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
  async updateCard(id: string, rate?: number, rematched = false, pcOut = false): Promise<CardOutcome> {
    let card = this.store.get('cards', id) as Card | undefined;
    if (!card) return 'skipped';
    if (card.pricing?.source === 'off') return 'off';
    if (card.status === 'sold' || card.status === 'traded') return 'skipped';
    const checkedAt = this.now().toISOString();
    const cat = await this.catalogQuote(card);
    const eur = this.eur ?? (Number(this.store.get('settings', 'main')?.eurToCad) || null);
    const useCardmarket = this.schedule().cardmarket && !!eur;
    const catPriced = !!cat && (!!cat.tcgplayer || (useCardmarket && cat.cardmarketEur != null));

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
          found = await this.autoMatch(card, kept?.off ? [kept.source] : [], cat);
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
    // Links saved from PriceCharting's search before its "&amp;" was decoded ("Scarlet &amp; Violet").
    if (card.pricing?.source === 'pricecharting' && card.pricing.id && pcPath(card.pricing.id) !== card.pricing.id) {
      const path = pcPath(card.pricing.id);
      this.patchLink(id, { id: path, url: `https://www.pricecharting.com${path}` });
    }
    await this.findPair(id, cat);
    card = this.store.get('cards', id) as Card;
    const link = isLinked(card.pricing) ? card.pricing : null;
    if (!link && !catPriced) return unmatched ?? 'skipped';
    const pair = link && pairLinked(link.pair) && link.pair.source !== link.source ? link.pair : null;

    // Both sites at once: the main product gives the image and details too, the pair only its price.
    // TCGplayer's price comes from the card databases when they have it for the card's product.
    const foil = foilWanted(card);
    const strict = !foil && /^(common|uncommon)$/i.test(String(card.rarity ?? ''));
    const fromCatalog = (l: { id: string; linkedBy?: 'auto' | 'user' | null }) => !!cat?.tcgplayer && (cat.tcgplayer.productId ? cat.tcgplayer.productId === l.id : l.linkedBy !== 'user');
    const quote = (l: { source: Source; id: string; linkedBy?: 'auto' | 'user' | null }, main: boolean): Promise<Quote> => {
      if (l.source === 'tcgplayer' && fromCatalog(l)) return Promise.resolve({ usd: cat!.tcgplayer!.usd, image: tcgImage(l.id, 1000), info: null });
      return this.ask(l.source, () => (l.source === 'pricecharting' ? quotePriceCharting(this.fetcher, l.id) : quoteTcgplayer(this.fetcher, l.id, foil, strict, main)));
    };
    const [mainQ, pairQ] = await Promise.allSettled([link ? quote(link, true) : Promise.resolve(null), pair ? quote(pair, false) : Promise.resolve(null)]);
    // The product moved (renamed or merged on the site): match the card again, once.
    if (link && mainQ.status === 'rejected' && mainQ.reason instanceof ProductGone && !rematched) {
      this.log.warn('pricing', `${label(card)}: ${mainQ.reason.message} Matching it again.`);
      this.patchLink(id, { source: 'none', id: null, url: null, title: null, set: null, linkedBy: null, candidates: null, error: null }, true);
      return this.updateCard(id, rate, true);
    }
    // PriceCharting just refused us and the card has no TCGplayer product yet: look for one now.
    if (link && mainQ.status === 'rejected' && link.source === 'pricecharting' && !pair && !link.pair?.off && this.siteOut('pricecharting') && !pcOut) {
      return this.updateCard(id, rate, rematched, true);
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
    const quotes: Partial<Record<PriceSource, number>> = {};
    if (link && main?.usd != null) quotes[link.source] = main.usd;
    if (pair && other?.usd != null) quotes[pair.source] = other.usd;
    // The databases' TCGplayer price for a card with no TCGplayer product of its own (unless the
    // person turned TCGplayer off for it, or chose a product the databases don't name).
    const ownTcg = link?.source === 'tcgplayer' ? link : pair?.source === 'tcgplayer' ? pair : null;
    const tcgOff = link?.pair?.source === 'tcgplayer' && !!link.pair.off;
    if (cat?.tcgplayer && quotes.tcgplayer == null && !tcgOff && (!ownTcg || fromCatalog(ownTcg))) quotes.tcgplayer = cat.tcgplayer.usd;
    if (useCardmarket && cat?.cardmarketEur != null) quotes.cardmarket = round2((cat.cardmarketEur * eur!) / fx);
    const best = (Object.entries(quotes) as [PriceSource, number][]).reduce<[PriceSource, number] | null>((b, q) => (!b || q[1] > b[1] ? q : b), null);
    if (!best && unmatched) {
      if (cat) this.patchLink(id, { catalog: catalogOf(cat) });
      return unmatched;
    }
    if (!best && mainError && link) {
      const out = mainQ.status === 'rejected' && !pair && this.siteOut(link.source);
      if (out && !link.pair?.off) mainError = `${out} ${SOURCE_NAME[otherSite(link.source)]} didn't find this card: choose its product with Change match.`;
      this.patchLink(id, { error: mainError, checkedAt, ...withPair, ...(cat ? { catalog: catalogOf(cat) } : {}) });
      return 'failed';
    }
    // Priced from another source while the main site is out: the update's summary says why, once.
    if (best && link && mainQ.status === 'rejected' && this.siteOut(link.source)) mainError = null;

    // The largest picture: a PriceCharting picture the card already has is kept (it's as large);
    // otherwise pokemontcg.io's, then PriceCharting's, then the main product's.
    const pcPicture = link?.source === 'pricecharting' ? (main?.image ?? null) : null;
    const hasPcPicture = !!card.officialImageId && /pricecharting/i.test(card.pricing?.imageUrl ?? '');
    const picture = hasPcPicture ? pcPicture : (cat?.image ?? pcPicture ?? main?.image ?? null);
    const image = picture ? await this.fetchImage(card, picture) : null;

    // Network work is done: re-read the card so nothing the person changed meanwhile is lost.
    const fresh = this.store.get('cards', id) as Card | undefined;
    if (!fresh || fresh.pricing?.source === 'off') return 'skipped';
    if (link ? !isLinked(fresh.pricing) || fresh.pricing.id !== link.id : isLinked(fresh.pricing)) return 'skipped';
    const date = this.today();
    const cutoff = this.today(new Date(Date.parse(`${date}T12:00:00Z`) - this.keepDays * 86_400_000));
    let prices = thinAutoPrices(fresh.prices ?? [], date, cutoff);
    if (best) {
      const [src, usd] = best;
      const each = (Object.entries(quotes) as [PriceSource, number][]).map(([s, v]) => `${SOURCE_NAME[s]} ${s === 'cardmarket' ? `€${cat!.cardmarketEur!.toFixed(2)} (US$${v.toFixed(2)})` : `US$${v.toFixed(2)}`}`);
      const list = each.length > 2 ? `highest of ${each.slice(0, -1).join(', ')} and ${each.at(-1)}` : each.length > 1 ? `higher of ${each.join(' and ')}` : src === 'cardmarket' ? each[0] : `US$${usd.toFixed(2)}`;
      prices = [
        ...prices,
        {
          id: rid(),
          at: checkedAt,
          type: 'market',
          amount: round2(usd * fx),
          currency: 'CAD',
          date,
          where: SOURCE_NAME[src],
          note: `Daily update · ${list} at ${fx.toFixed(4)}${quotes.cardmarket != null ? ` (€1 = C$${eur!.toFixed(4)})` : ''}`,
          auto: true,
          usd,
          quotes,
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
        ...(image ? { imageUrl: image.url } : {}),
        ...(cat ? { catalog: catalogOf(cat) } : {}),
      },
      updatedAt: checkedAt,
    };
    if (image) patch.officialImageId = image.id;
    // The product's set, release date and rarity, for cards that lack them (or that the person
    // matched to a product from another set).
    if (link && main?.info) {
      const d = detailsFromProduct(fresh, main.info, link.linkedBy === 'user');
      if (d.filled.length) {
        Object.assign(patch, d.patch);
        const was = d.patch.set && !String(fresh.set ?? '').trim() ? '' : d.patch.set ? ` (was ${fresh.set})` : '';
        this.log.info('pricing', `${label(fresh)}: ${d.filled.map((f) => `${f} ${d.patch[f]}`).join(', ')}${was} from ${SOURCE_NAME[link.source]}`);
      }
    }
    this.store.update('cards', id, patch);
    if (image && oldImage && oldImage !== image.id && !this.store.referencedImages().has(oldImage)) this.assets.remove(oldImage);
    return best ? 'updated' : 'noPrice';
  }

  /** What the card databases say about the card today, or null when it isn't matched to TCGdex (or they didn't answer). */
  private async catalogQuote(card: Card): Promise<CatalogQuote | null> {
    const tcgdexId = (card.details as { id?: string | null } | null | undefined)?.id;
    if (!this.catalog || !tcgdexId) return null;
    const known = card.pricing?.catalog?.tcgdexId === tcgdexId ? card.pricing.catalog : {};
    try {
      const q = await this.catalog.quote(tcgdexId, printingOf(card.variant, card.rarity), known, card.setCode as string | undefined);
      for (const e of q.errors) this.log.warn('pricing', `${label(card)}: ${e}`);
      return q;
    } catch (err) {
      this.log.warn('pricing', `${label(card)}: no prices from TCGdex: ${message(err)}`);
      return null;
    }
  }

  /**
   * Look for the card's product on its other site, when it has never been looked for there, or
   * wasn't found a week ago. A PriceCharting product found for a card matched on TCGplayer becomes
   * its main product (details and image come from PriceCharting); TCGplayer's becomes the pair.
   * The TCGplayer product the card databases name (catalog.ts) is taken without searching.
   */
  private async findPair(id: string, cat: CatalogQuote | null = null): Promise<void> {
    const card = this.store.get('cards', id) as Card | undefined;
    if (!card || !isLinked(card.pricing)) return;
    const site = otherSite(card.pricing.source);
    const p = card.pricing.pair;
    const known = site === 'tcgplayer' ? catalogProduct(cat) : null;
    // A product the person chose (or turning TCGplayer off) stands; an automatic match gives way to the databases'.
    if (known && !(p && p.source === site && (p.off || (p.id && (p.linkedBy === 'user' || p.id === known.id))))) {
      const at = this.now().toISOString();
      this.store.update('cards', id, { pricing: { ...card.pricing, pair: { ...productOf(known), linkedBy: 'auto', linkedAt: at, checkedAt: at } } });
      return;
    }
    if (this.siteOut(site)) return;
    // While the main site is out, its card is priced from this one: look again straight away.
    const now = !!this.siteOut(card.pricing.source);
    if (p && p.source === site && (p.off || p.id || (!now && Date.parse(p.checkedAt ?? '') > this.now().getTime() - PAIR_RETRY_MS))) return;
    let list: Candidate[];
    try {
      const q = searchQuery(card);
      list = await this.ask(site, () => (site === 'pricecharting' ? searchPriceCharting(this.fetcher, q) : this.searchTcgplayerFor(card, q)));
    } catch (err) {
      this.log.warn('pricing', `Couldn't search ${SOURCE_NAME[site]} for ${label(card)}: ${message(err)}`);
      return; // looked for again next time
    }
    const at = this.now().toISOString();
    const m = chooseMatch(card, list).match;
    const fresh = this.store.get('cards', id) as Card | undefined;
    if (!fresh || !isLinked(fresh.pricing) || fresh.pricing.id !== card.pricing.id) return;
    if (m && site === 'pricecharting') {
      this.log.info('pricing', `${label(card)}: found on PriceCharting, which now gives its details and image; TCGplayer still gives a price`);
      this.store.update('cards', id, { pricing: { ...fresh.pricing, ...productOf(m), linkedBy: 'auto', linkedAt: at, pair: { ...productOf(fresh.pricing), checkedAt: at } } });
    } else {
      const pair: Pair = m ? { ...productOf(m), linkedBy: 'auto', linkedAt: at, checkedAt: at } : { source: site, id: null, checkedAt: at };
      this.store.update('cards', id, { pricing: { ...fresh.pricing, pair } });
    }
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

  /**
   * Search both sites (except any in `skip`). The card's main product is PriceCharting's certain
   * match, or else TCGplayer's; the other site's certain match, if any, is its pair. A site that
   * didn't answer leaves no pair, so it's looked for again next time.
   */
  async autoMatch(card: CardForMatch, skip: Source[] = [], cat: CatalogQuote | null = null): Promise<{ match: Candidate | null; candidates: Candidate[]; pair?: Pair }> {
    const q = searchQuery(card);
    const at = this.now().toISOString();
    let usePc = !skip.includes('pricecharting') && !this.siteOut('pricecharting');
    // PriceCharting failing doesn't stop TCGplayer being asked; the card fails only if neither finds it.
    let pcError: unknown = null;
    let pc: MatchResult = { match: null, candidates: [] };
    if (usePc) {
      try {
        pc = chooseMatch(card, await this.ask('pricecharting', () => searchPriceCharting(this.fetcher, q)));
      } catch (err) {
        pcError = err;
        usePc = false;
      }
    }
    let tg: MatchResult | null = null;
    const known = catalogProduct(cat);
    if (known && !skip.includes('tcgplayer')) tg = { match: known, candidates: [known] };
    else if (!skip.includes('tcgplayer')) {
      if (usePc || pcError) await this.pause();
      tg = await this.ask('tcgplayer', () => this.searchTcgplayerFor(card, q)).then(
        (list) => chooseMatch(card, list),
        () => null,
      );
    }
    const asPair = (r: MatchResult | null, source: Source): Pair | undefined =>
      !r ? undefined : r.match ? { ...productOf(r.match), linkedBy: 'auto', linkedAt: at, checkedAt: at } : { source, id: null, checkedAt: at };
    if (pc.match) return { ...pc, pair: asPair(tg, 'tcgplayer') };
    if (tg?.match) return { ...tg, pair: usePc ? asPair(pc, 'pricecharting') : undefined };
    // Neither site answered, or PriceCharting failed for a moment (it wasn't refusing us): try the card again next time.
    if (pcError && (!tg || !(pcError instanceof SiteOut || pcError instanceof Refused))) throw pcError;
    const pcOut = !skip.includes('pricecharting') && !pcError && !usePc ? this.siteOut('pricecharting') : null;
    if (pcOut && !tg) throw new SiteOut(pcOut);
    return { match: null, candidates: [...pc.candidates.slice(0, 5), ...(tg?.candidates ?? []).slice(0, 3)] };
  }

  /** TCGplayer's products for the card: by name and number, then by name and set if that found nothing certain. */
  private async searchTcgplayerFor(card: CardForMatch, q: string): Promise<Candidate[]> {
    const list = await searchTcgplayer(this.fetcher, q);
    const bySet = setSearchQuery(card);
    if (chooseMatch(card, list).match || !bySet || bySet === q) return list;
    await this.pause();
    const more = await searchTcgplayer(this.fetcher, bySet);
    return [...list, ...more.filter((c) => !list.some((x) => x.id === c.id))];
  }

  /** Products the person can choose from, from both sites. */
  async search(card: CardForMatch, query?: string): Promise<Candidate[]> {
    const q = query?.trim() || searchQuery(card);
    const [pc, tg] = await Promise.all([this.ask('pricecharting', () => searchPriceCharting(this.fetcher, q)).catch(() => []), searchTcgplayer(this.fetcher, q).catch(() => [])]);
    const rank = (list: Candidate[]) => chooseMatch(card, list).candidates.concat(list).filter((c, i, a) => a.findIndex((x) => x.source === c.source && x.id === c.id) === i);
    return [...rank(pc).slice(0, 10), ...rank(tg).slice(0, 6)];
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
