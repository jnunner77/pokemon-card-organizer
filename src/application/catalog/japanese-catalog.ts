import { entriesOf, type JapaneseCard, type JapaneseEntry, type JapaneseIndexData, type JapaneseSet, MAX_CARDS } from '#domain/catalog/japanese.ts';

/**
 * The Japanese card index in memory: every set with its cards, and the keys lookups compare.
 * Lookups read it straight away, whatever the refresh is doing; the refresh puts one set at a
 * time. It does no I/O.
 */
export class JapaneseCatalog {
  readonly #sets = new Map<number, { set: JapaneseSet; entries: JapaneseEntry[]; cards: readonly JapaneseCard[] }>();
  #flat: JapaneseEntry[] | null = null;
  #codes: ReadonlySet<string> | null = null;
  #cards = 0;
  /** When the last complete build or refresh finished (ISO); null until the first build finishes. */
  completedAt: string | null = null;
  /** How far a refresh in progress is. */
  progress = { running: false, done: 0, total: 0 };

  /** Replace everything with a saved index. */
  load(data: JapaneseIndexData): void {
    this.#sets.clear();
    this.#cards = 0;
    this.completedAt = data.completedAt;
    for (const s of data.sets) this.put(s.set, s.cards);
    this.#changed();
  }

  /** Add or replace one set. False (and the set's cards left out) when the index is full. */
  put(set: JapaneseSet, cards: readonly JapaneseCard[]): boolean {
    const old = this.#sets.get(set.groupId);
    const room = MAX_CARDS - this.#cards + (old?.cards.length ?? 0);
    const kept = cards.slice(0, Math.max(0, room));
    this.#cards += kept.length - (old?.cards.length ?? 0);
    this.#sets.set(set.groupId, { set, entries: entriesOf(set, kept), cards: kept });
    this.#changed();
    return kept.length === cards.length;
  }

  drop(groupId: number): void {
    const old = this.#sets.get(groupId);
    if (!old) return;
    this.#cards -= old.cards.length;
    this.#sets.delete(groupId);
    this.#changed();
  }

  /** A set's name, code and date changed, its cards didn't. */
  updateMeta(set: JapaneseSet): void {
    const old = this.#sets.get(set.groupId);
    if (!old) return;
    this.#sets.set(set.groupId, { set, entries: entriesOf(set, old.cards), cards: old.cards });
    this.#changed();
  }

  sets(): JapaneseSet[] {
    return [...this.#sets.values()].map((s) => s.set);
  }

  /** What to save. */
  data(): JapaneseIndexData {
    return { version: 1, completedAt: this.completedAt, sets: [...this.#sets.values()].map((s) => ({ set: s.set, cards: s.cards })) };
  }

  /** Every card, as one list (kept until the index changes). */
  entries(): readonly JapaneseEntry[] {
    this.#flat ??= [...this.#sets.values()].flatMap((s) => s.entries);
    return this.#flat;
  }

  entry(groupId: number, productId: number): JapaneseEntry | null {
    return this.#sets.get(groupId)?.entries.find((e) => e.card.productId === productId) ?? null;
  }

  /** The lower-cased set codes, for telling "sv2a" from a card number. */
  codes(): ReadonlySet<string> {
    this.#codes ??= new Set([...this.#sets.values()].flatMap((s) => (s.set.code ? [s.set.code.toLowerCase()] : [])));
    return this.#codes;
  }

  cardCount(): number {
    return this.#cards;
  }

  /** Ready once a build has completed or there is anything to search; otherwise how far the first build is. */
  readiness(): { readonly ready: true } | { readonly ready: false; readonly done: number; readonly total: number } {
    if (this.completedAt !== null || this.#sets.size > 0) return { ready: true };
    return { ready: false, done: this.progress.done, total: this.progress.total };
  }

  #changed(): void {
    this.#flat = null;
    this.#codes = null;
  }
}
