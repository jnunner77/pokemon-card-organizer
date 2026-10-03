import type { Assets } from '../assets';
import { MAX_IMAGE_BYTES } from '../assets';
import type { Doc } from '../schema';
import type { Store } from '../store';
import { chooseMatch, searchQuery, type CardForMatch } from './match';
import {
  type Candidate,
  type Fetcher,
  type Quote,
  type Source,
  SourceError,
  get,
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

  constructor(o: UpdaterOptions) {
    this.store = o.store;
    this.assets = o.assets;
    this.fetcher = o.fetcher ?? fetch;
    this.now = o.now ?? (() => new Date());
    this.timeZone = o.timeZone ?? 'America/Vancouver';
    this.hour = o.hour ?? 5;
    this.keepDays = o.keepDays ?? 30;
    this.delayMs = o.delayMs ?? 2000;
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
      if (this.running || this.localHour() < this.hour) return;
      const last = this.status().lastRun as RunSummary | undefined;
      if (last?.date === this.today()) return;
      this.runAll('schedule').catch((err) => console.error('Daily price update failed:', err));
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
    try {
      for (const id of ids) {
        const card = this.store.get('cards', id) as Card | undefined;
        let outcome: CardOutcome = 'skipped';
        if (card) {
          try {
            outcome = await this.updateCard(id, rate);
          } catch (err) {
            outcome = 'failed';
            console.error(`Price update for ${label(card)} failed:`, err);
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
      this.setStatus({ running: false, lastRun: summary });
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
      console.warn('Using the saved exchange rate:', err instanceof Error ? err.message : err);
      return { rate: Number(main.usdToCad) > 0 ? Number(main.usdToCad) : 1.37, rateDate: (main.usdToCadDate as string) ?? null };
    }
  }

  // ---- one card ----------------------------------------------------------------------

  /** Find the card's product if needed, then log today's price and refresh its image. */
  async updateCard(id: string, rate?: number): Promise<CardOutcome> {
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
    const link = card.pricing as Link & { source: Source; id: string };

    let quote: Quote;
    try {
      quote = link.source === 'pricecharting' ? await quotePriceCharting(this.fetcher, link.id) : await quoteTcgplayer(this.fetcher, link.id, foilWanted(card), !foilWanted(card) && /^(common|uncommon)$/i.test(String(card.rarity ?? '')));
    } catch (err) {
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
      pricing: { ...fresh.pricing, checkedAt, error: quote.usd == null ? `${SOURCE_NAME[link.source]} has no price for this printing of the card. If it's the wrong product, choose another.` : null, ...(image ? { imageUrl: image.url } : {}) },
      updatedAt: checkedAt,
    };
    if (image) patch.officialImageId = image.id;
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
      console.warn(`No new image for ${label(card)}:`, message(err));
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
