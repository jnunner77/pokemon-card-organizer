import { type AnyCardPrices, type AnyCardPricing, type AnyCardToPrice, type CardChange, type CardChanges, type CardDatabase, type CardPricing, type Scheduler, SourceUnavailable, type TcgplayerCatalog } from '#application/catalog/ports.ts';
import type { TcgdexBrief, TcgdexCard, TcgdexSet, TcgdexSetBrief } from '#domain/catalog/tcgdex.ts';
import type { TcgGroup, TcgGroupContents } from '#domain/catalog/tcgplayer.ts';
import type { Fields } from '#domain/ledger/document.ts';
import { list, setFrom, tcgdexPaths } from '../catalog/tcgdex.ts';

// The card databases, the price update, the cards' changes and time in memory, for application
// tests.

/**
 * The card database in memory: TCGdex's answers as recorded (by what was asked, as the API's
 * paths: "/cards?name=Pikachu"), and what it was asked. Anything not recorded isn't there (404).
 */
export class MemoryCardDatabase implements CardDatabase {
  readonly #answers: (path: string) => unknown;
  /** Every question, in order. */
  readonly asked: string[] = [];
  /** Set to fail every question, as when TCGdex can't be reached. */
  down = false;

  /** `answers`: recorded answers by path, or how to answer one (undefined: not there). */
  constructor(answers: ReadonlyMap<string, unknown> | ((path: string) => unknown)) {
    this.#answers = typeof answers === 'function' ? answers : (path) => answers.get(path);
  }

  async cardsNamed(name: string): Promise<readonly TcgdexBrief[]> {
    return list<TcgdexBrief>(this.#answer(tcgdexPaths.cardsNamed(name)));
  }

  async cardsNumbered(localId: string): Promise<readonly TcgdexBrief[]> {
    return list<TcgdexBrief>(this.#answer(tcgdexPaths.cardsNumbered(localId)));
  }

  async card(id: string): Promise<TcgdexCard> {
    // Recorded JSON, typed as the adapter types it.
    return this.#answer(tcgdexPaths.card(id)) as TcgdexCard;
  }

  async set(id: string): Promise<TcgdexSet> {
    return setFrom(this.#answer(tcgdexPaths.set(id)), id);
  }

  async sets(): Promise<readonly TcgdexSetBrief[]> {
    return list<TcgdexSetBrief>(this.#answer(tcgdexPaths.sets()));
  }

  async setsNamed(name: string): Promise<readonly TcgdexSetBrief[]> {
    return list<TcgdexSetBrief>(this.#answer(tcgdexPaths.setsNamed(name)));
  }

  async pocketSets(): Promise<ReadonlySet<string>> {
    try {
      const serie = this.#answer(tcgdexPaths.pocketSets()) as { sets?: unknown } | null;
      return new Set(list<{ id: string }>(serie?.sets).map((x) => x.id));
    } catch {
      return new Set();
    }
  }

  #answer(path: string): unknown {
    this.asked.push(path);
    if (this.down) throw new SourceUnavailable("Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND api.tcgdex.net");
    const answer = this.#answers(path);
    if (answer === undefined) throw new SourceUnavailable('api.tcgdex.net answered 404', 404);
    return structuredClone(answer);
  }
}

/** TCGplayer's catalog in memory: its sets, and each set's products and prices. */
export class MemoryTcgplayerCatalog implements TcgplayerCatalog {
  readonly #groups: readonly TcgGroup[];
  readonly #contents: ReadonlyMap<number, TcgGroupContents>;
  /** Set to fail every download, as when tcgcsv.com doesn't answer. */
  down = false;
  /** How many times it was told to ask again. */
  resets = 0;

  constructor(groups: readonly TcgGroup[], contents: ReadonlyMap<number, TcgGroupContents>) {
    this.#groups = groups;
    this.#contents = contents;
  }

  reset(): void {
    this.resets++;
  }

  async groupList(): Promise<readonly TcgGroup[]> {
    if (this.down) throw new SourceUnavailable('tcgcsv.com answered 503', 503);
    return this.#groups;
  }

  async group(groupId: number): Promise<TcgGroupContents> {
    if (this.down) throw new SourceUnavailable('tcgcsv.com answered 503', 503);
    return this.#contents.get(groupId) ?? { products: [], prices: [] };
  }
}

/** Time that passes at once: pauses end straight away (each one noted), and jobs run when told to. */
export class InstantScheduler implements Scheduler {
  readonly pauses: number[] = [];
  readonly #jobs = new Map<number, { readonly ms: number; readonly job: () => void }>();
  #next = 0;

  async pause(ms: number): Promise<void> {
    this.pauses.push(ms);
  }

  after(ms: number, job: () => void): () => void {
    const id = this.#next++;
    this.#jobs.set(id, { ms, job });
    return () => void this.#jobs.delete(id);
  }

  /** The jobs waiting, by how long they were to wait. */
  get waiting(): number[] {
    return [...this.#jobs.values()].map((j) => j.ms);
  }

  /** Run every job waiting now. */
  runAll(): void {
    const jobs = [...this.#jobs.values()];
    this.#jobs.clear();
    for (const j of jobs) j.job();
  }
}

/** The cards' changes in memory: the cards come from a table; changes are told by the test. */
export class MemoryCardChanges implements CardChanges {
  readonly #cards: ReadonlyMap<string, Fields>;
  readonly #listeners = new Set<(change: CardChange) => void>();

  constructor(cards: ReadonlyMap<string, Fields>) {
    this.#cards = cards;
  }

  current(): readonly { readonly id: string; readonly card: Fields }[] {
    return [...this.#cards].map(([id, card]) => ({ id, card: structuredClone(card) }));
  }

  subscribe(listener: (change: CardChange) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Tell the listeners about a change. */
  emit(change: CardChange): void {
    for (const listener of this.#listeners) listener(change);
  }

  get listening(): number {
    return this.#listeners.size;
  }
}

/** The daily price update in memory: whether it can price a card now, and the cards it priced. */
export class MemoryCardPricing implements CardPricing {
  enabled = true;
  running = false;
  outcome = 'updated';
  readonly priced: string[] = [];
  /** Called as each card is priced (to look at the card then). */
  onPrice: (id: string) => void = () => undefined;

  canPriceNow(): boolean {
    return this.enabled && !this.running;
  }

  async updateCard(id: string): Promise<string> {
    this.priced.push(id);
    this.onPrice(id);
    return this.outcome;
  }
}

/** Any card priced in memory: each printing as the card database gives it, at fixed rates. */
export class MemoryAnyCardPricing implements AnyCardPricing {
  readonly asked: AnyCardToPrice[] = [];

  async price(card: AnyCardToPrice): Promise<AnyCardPrices> {
    this.asked.push(card);
    return {
      printings: card.printings.map((p) => ({
        printing: { label: p.label, variant: p.variant, tcgplayer: p.tcgplayer ? { usd: p.tcgplayer.usd, url: null } : null, cardmarket: p.cardmarketEur != null ? { eur: p.cardmarketEur } : null, pricecharting: null, leftOut: null, price: null },
        product: p.tcgplayer?.productId ?? null,
      })),
      rates: { usd: 1.37, eur: null },
      notes: [],
    };
  }
}
