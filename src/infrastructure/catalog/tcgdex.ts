import type { CardDatabase } from '#application/catalog/ports.ts';
import type { TcgdexBrief, TcgdexCard, TcgdexSet, TcgdexSetBrief } from '#domain/catalog/tcgdex.ts';
import type { Clock } from '#application/ports.ts';
import { type Fetcher, get } from '../http/get.ts';

const API = 'https://api.tcgdex.net/v2/en';

/** What each question asks TCGdex's API for, after its address. */
export const tcgdexPaths = {
  cardsNamed: (name: string) => `/cards?name=${encodeURIComponent(name)}`,
  cardsNumbered: (localId: string) => `/cards?localId=${encodeURIComponent(localId)}`,
  card: (id: string) => `/cards/${encodeURIComponent(id)}`,
  set: (id: string) => `/sets/${encodeURIComponent(id)}`,
  sets: () => '/sets',
  setsNamed: (name: string) => `/sets?name=${encodeURIComponent(name)}`,
  pocketSets: () => '/series/tcgp',
};

/** How long answers are remembered: a set's for a day, everything else for an hour. */
const SET_TTL_MS = 86_400_000;
const TTL_MS = 3_600_000;
/** Most answers remembered at once. */
const MAX_REMEMBERED = 2000;

export interface TcgdexOptions {
  readonly fetcher?: Fetcher | undefined;
  readonly clock?: Clock | undefined;
}

// Raw JSON from TCGdex, read loosely (typed at this boundary; the domain reads it field by field).
export const list = <T>(value: unknown): readonly T[] => (Array.isArray(value) ? (value as T[]) : []);
/** A set as TCGdex sent it, with its id, name and list of cards always there. */
export const setFrom = (raw: unknown, id: string): TcgdexSet => {
  const s = raw as TcgdexSet | null;
  return { ...s, id: s?.id ?? id, name: s?.name ?? '', cards: list<TcgdexBrief>(s?.cards) };
};

/**
 * TCGdex (https://tcgdex.dev), a free, open database of Pokémon cards, over its API. Answers are
 * remembered for an hour (sets for a day) so typing a card doesn't repeat requests; a failed one
 * is asked again next time.
 */
export class TcgdexCardDatabase implements CardDatabase {
  readonly #fetcher: Fetcher;
  readonly #clock: Clock;
  readonly #cache = new Map<string, { readonly at: number; readonly value: Promise<unknown> }>();
  #pocket: { readonly at: number; readonly ids: ReadonlySet<string> } | null = null;

  constructor(o: TcgdexOptions = {}) {
    this.#fetcher = o.fetcher ?? fetch;
    this.#clock = o.clock ?? { now: () => new Date() };
  }

  async cardsNamed(name: string): Promise<readonly TcgdexBrief[]> {
    return list<TcgdexBrief>(await this.#json(tcgdexPaths.cardsNamed(name)));
  }

  async cardsNumbered(localId: string): Promise<readonly TcgdexBrief[]> {
    return list<TcgdexBrief>(await this.#json(tcgdexPaths.cardsNumbered(localId)));
  }

  async card(id: string): Promise<TcgdexCard> {
    return (await this.#json(tcgdexPaths.card(id))) as TcgdexCard;
  }

  async set(id: string): Promise<TcgdexSet> {
    return setFrom(await this.#json(tcgdexPaths.set(id)), id);
  }

  async sets(): Promise<readonly TcgdexSetBrief[]> {
    return list<TcgdexSetBrief>(await this.#json(tcgdexPaths.sets()));
  }

  async setsNamed(name: string): Promise<readonly TcgdexSetBrief[]> {
    return list<TcgdexSetBrief>(await this.#json(tcgdexPaths.setsNamed(name)));
  }

  async pocketSets(): Promise<ReadonlySet<string>> {
    const now = this.#clock.now().getTime();
    if (!this.#pocket || now - this.#pocket.at > SET_TTL_MS) {
      const serie = (await this.#json(tcgdexPaths.pocketSets()).catch(() => null)) as { sets?: unknown } | null;
      this.#pocket = { at: now, ids: new Set(list<{ id: string }>(serie?.sets).map((x) => x.id)) };
    }
    return this.#pocket.ids;
  }

  /** GET a TCGdex path as JSON, remembered for a while. */
  #json(path: string): Promise<unknown> {
    const ttl = path.startsWith('/sets/') ? SET_TTL_MS : TTL_MS;
    const now = this.#clock.now().getTime();
    const hit = this.#cache.get(path);
    if (hit && now - hit.at < ttl) return hit.value;
    const value = get(this.#fetcher, API + path, { headers: { Accept: 'application/json' } }).then((r) => r.json() as Promise<unknown>);
    value.catch(() => this.#cache.delete(path));
    this.#cache.set(path, { at: now, value });
    if (this.#cache.size > MAX_REMEMBERED) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    return value;
  }
}
