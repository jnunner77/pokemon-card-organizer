import type { TcgplayerCatalog } from '#application/catalog/ports.ts';
import type { TcgGroup, TcgGroupContents, TcgPrice, TcgProduct } from '#domain/catalog/tcgplayer.ts';
import { type Fetcher, get, SourceError } from '../http/get.ts';

// TCGplayer's own catalog, from tcgcsv.com: a free public copy of TCGplayer's catalog API (sets,
// products and prices as JSON, no key), refreshed every day around 20:00 UTC. Pokémon is category
// 3; each set is a "group" with its products (cards and sealed products) and their prices by
// printing ("Normal", "Holofoil", "Reverse Holofoil"…). Only the sets asked for are downloaded,
// each at most once a day, one at a time and a quarter second apart, and after failing three times in a row it
// isn't asked again until reset().

const TCGCSV = 'https://tcgcsv.com/tcgplayer/3';

export interface TcgCsvOptions {
  readonly fetcher?: Fetcher | undefined;
  readonly now?: (() => Date) | undefined;
  /** Pause between downloads (tcgcsv.com is one person's hobby). */
  readonly gapMs?: number | undefined;
}

/** Downloads from tcgcsv.com, keeping each day's. */
export class TcgCsvClient implements TcgplayerCatalog {
  static readonly breakerAfter = 3;
  readonly #fetcher: Fetcher;
  readonly #now: () => Date;
  readonly #gapMs: number;
  #day = '';
  #groups: Promise<readonly TcgGroup[]> | null = null;
  readonly #sets = new Map<number, Promise<TcgGroupContents>>();
  #last = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #streak = 0;
  /** Downloads since the server started, for the logs and tests. */
  downloads = 0;

  constructor(o: TcgCsvOptions = {}) {
    this.#fetcher = o.fetcher ?? fetch;
    this.#now = o.now ?? (() => new Date());
    this.#gapMs = o.gapMs ?? 250;
  }

  /** Start of an update, or someone asking now: ask again even if it kept failing. */
  reset(): void {
    this.#streak = 0;
  }

  /** Today's list of Pokémon sets; a failed download is tried again next time. */
  groupList(): Promise<readonly TcgGroup[]> {
    this.#fresh();
    this.#groups ??= this.#json<TcgGroup>('/groups').catch((err: unknown) => {
      this.#groups = null;
      throw err;
    });
    return this.#groups;
  }

  /** One set's products and prices, downloaded at most once a day. */
  group(groupId: number): Promise<TcgGroupContents> {
    this.#fresh();
    let s = this.#sets.get(groupId);
    if (!s) {
      s = (async () => ({ products: await this.#json<TcgProduct>(`/${groupId}/products`), prices: await this.#json<TcgPrice>(`/${groupId}/prices`) }))();
      s.catch(() => this.#sets.delete(groupId));
      this.#sets.set(groupId, s);
    }
    return s;
  }

  #fresh(): void {
    const day = this.#now().toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#groups = null;
      this.#sets.clear();
    }
  }

  /** Downloads wait their turn: one at a time, so the gap between them holds however many are asked for at once. */
  #json<T>(path: string): Promise<readonly T[]> {
    const turn = this.#queue.then(() => this.#download<T>(path));
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  async #download<T>(path: string): Promise<readonly T[]> {
    if (this.#streak >= TcgCsvClient.breakerAfter) throw new SourceError("Skipped: tcgcsv.com kept failing, so it isn't asked again until the next price update.");
    const wait = this.#last + this.#gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      this.downloads++;
      const res = await get(this.#fetcher, `${TCGCSV}${path}`, { headers: { Accept: 'application/json' } }, { timeoutMs: 20_000, attempts: 2, maxWaitMs: 5_000 });
      // Raw JSON from tcgcsv.com, typed at this boundary.
      const body = (await res.json()) as { success?: boolean; results?: unknown };
      if (!Array.isArray(body.results)) throw new SourceError('tcgcsv.com sent no results');
      this.#streak = 0;
      return body.results as T[];
    } catch (err) {
      this.#streak++;
      throw err;
    } finally {
      this.#last = Date.now();
    }
  }
}
