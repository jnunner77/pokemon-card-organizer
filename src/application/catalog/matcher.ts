import {
  cardQuery,
  closeNames,
  type DetailsMatch,
  type DetailsOption,
  type Filing,
  filing,
  filingLabel,
  MAX_MATCHES,
  matchOf,
  type NamedSet,
  namedIn,
  namedSet,
  narrowByHints,
  narrowToFamily,
  type SetHints,
  sameCards,
  setNamedExactly,
  suggestions,
  type CardQuery,
} from '#domain/catalog/details.ts';
import { isBlank, ownNumber, setLabel } from '#domain/catalog/names.ts';
import { isSubSet, type TcgdexBrief } from '#domain/catalog/tcgdex.ts';
import type { CardDatabase } from './ports.ts';

/**
 * Finding a card in the card database by what the person typed: its name and number, narrowed by
 * the set size ("51/162") and whatever set or set code they typed. Shared by looking a card up
 * and filling one in. The card database's failures are thrown (SourceUnavailable).
 */
export class CardMatcher {
  readonly #db: CardDatabase;

  constructor(db: CardDatabase) {
    this.#db = db;
  }

  /** The cards with this name and number. Several mean the person should choose. */
  async lookup(name: string, number: string, hints: SetHints = {}): Promise<readonly DetailsMatch[]> {
    const q = cardQuery(name, number);
    if (!q) return [];
    const pocket = await this.#db.pocketSets();
    let hits = sameCards(await this.#db.cardsNamed(q.word), q, pocket);
    // Not found by name (an unusual spelling or accent): every card with that number, then the name.
    if (!hits.length) hits = sameCards(await this.#db.cardsNumbered(q.own), q, pocket);
    let matches = narrowByHints(await Promise.all(hits.map((h) => this.match(h.id))), number, hints);
    // The set the card is filed under, when TCGdex knows it by that name: its own cards first, then
    // the same name in its reprint sub-sets (which keep the original's number), rather than a card
    // from an unrelated set that only shares the number.
    const named = isBlank(hints.set) ? null : await this.setNamed(hints.set).catch(() => null);
    if (named) {
      const family = narrowToFamily(matches, named.id);
      matches = family.matches;
      if (family.none) {
        const reprints = await this.#inSubSets(named.id, q).catch(() => []);
        if (reprints.length) matches = reprints;
      }
    }
    return matches.slice(0, MAX_MATCHES);
  }

  /** One card by its TCGdex id, with its set's code and release date. */
  async match(id: string): Promise<DetailsMatch> {
    const c = await this.#db.card(id);
    const s = await this.#db.set(c.set.id).catch(() => null);
    return matchOf(c, s);
  }

  /** The TCGdex set a label names exactly ("Pokemon Crown Zenith" → swsh12.5), or null. */
  async setNamed(label: unknown): Promise<NamedSet | null> {
    const name = setLabel(label);
    if (!name) return null;
    const hit = setNamedExactly(await this.#db.setsNamed(name).catch(() => []), name);
    if (!hit) return null;
    return namedSet(hit, await this.#db.set(hit.id).catch(() => null));
  }

  /** A match checked against the set the card is filed under. */
  async filing(m: DetailsMatch, filedUnder: unknown): Promise<Filing> {
    const label = filingLabel(m, filedUnder);
    return filing(m, filedUnder, label ? await this.setNamed(label) : null);
  }

  /** Cards with this number whose names are close to the one typed (a misspelling such as "Eelktross"). */
  async suggest(name: string, number: string, hints: SetHints = {}): Promise<DetailsOption[]> {
    const own = ownNumber(number);
    if (!own || !name.trim()) return [];
    const list = await this.#db.cardsNumbered(own).catch(() => []);
    const matches = await Promise.all(closeNames(list, name, own).map((c) => this.match(c.id)));
    return suggestions(matches, number, hints);
  }

  /** The cards with one of the card's names in a set's reprint sub-sets. */
  async #inSubSets(setId: string, q: CardQuery): Promise<DetailsMatch[]> {
    const subs = (await this.#db.sets()).filter((x) => isSubSet(setId, x.id));
    const found: TcgdexBrief[] = [];
    for (const sub of subs) {
      const full = await this.#db.set(sub.id).catch(() => null);
      found.push(...namedIn(full?.cards ?? [], q));
    }
    return Promise.all(found.slice(0, MAX_MATCHES).map((c) => this.match(c.id)));
  }
}
