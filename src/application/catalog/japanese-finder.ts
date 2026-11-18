import { type DetailsMatch, type DetailsOption, type Filing, filing, filingLabel, type SetHints, suggestions } from '#domain/catalog/details.ts';
import { closeJapaneseNames, type JapaneseEntry, japaneseMatch, japaneseSetNamed, localOf, lookupJapanese, parseJapaneseMatchId } from '#domain/catalog/japanese.ts';
import { ownNumber } from '#domain/catalog/tcgplayer.ts';
import { JapaneseNotReady } from './errors.ts';
import type { CardFinder } from './finder.ts';
import type { JapaneseCatalog } from './japanese-catalog.ts';
import { type CardDatabase, SourceUnavailable } from './ports.ts';

/** The illustrator TCGdex's Japanese catalog gives a card (its set code and number), or null. */
export async function japaneseArtist(database: CardDatabase, e: JapaneseEntry): Promise<string | null> {
  if (!e.set.code) return null;
  try {
    return (await database.card(`${e.set.code}-${localOf(e.card.number)}`)).illustrator?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Finding a Japanese card in the Japanese index by its English name and number, narrowed by the
 * set. Answers straight away from memory; before the index's first build is done, lookups throw
 * JapaneseNotReady rather than match from a partial index. The illustrator is TCGdex's.
 */
export class JapaneseCardFinder implements CardFinder {
  readonly #catalog: JapaneseCatalog;
  readonly #database: CardDatabase;

  constructor(catalog: JapaneseCatalog, database: CardDatabase) {
    this.#catalog = catalog;
    this.#database = database;
  }

  async lookup(name: string, number: string, hints: SetHints = {}): Promise<readonly DetailsMatch[]> {
    // Matching (what a lookup records or applies) waits for the first build to finish: a partial
    // index could hold only some of the sets a card number is in. Searching may use a partial one.
    if (this.#catalog.completedAt === null) throw new JapaneseNotReady();
    const found = lookupJapanese(this.#catalog.entries(), name, number, hints);
    const [only] = found;
    if (only && found.length === 1) return [japaneseMatch(only, await japaneseArtist(this.#database, only))];
    return found.map((e) => japaneseMatch(e, null));
  }

  async match(id: string): Promise<DetailsMatch> {
    const p = parseJapaneseMatchId(id);
    const e = p ? this.#catalog.entry(p.groupId, p.productId) : null;
    if (!e) {
      if (p && !this.#catalog.readiness().ready) throw new JapaneseNotReady();
      throw new SourceUnavailable("That card isn't in TCGplayer's Japanese catalog any more.", 404);
    }
    return japaneseMatch(e, await japaneseArtist(this.#database, e));
  }

  async filing(m: DetailsMatch, filedUnder: unknown): Promise<Filing> {
    const label = filingLabel(m, filedUnder);
    return filing(m, filedUnder, label ? japaneseSetNamed(this.#catalog.sets(), label) : null);
  }

  async suggest(name: string, number: string, hints: SetHints = {}): Promise<DetailsOption[]> {
    const own = ownNumber(number);
    if (!own || !name.trim()) return [];
    return suggestions(closeJapaneseNames(this.#catalog.entries(), name, own).map((e) => japaneseMatch(e, null)), number, hints);
  }
}
