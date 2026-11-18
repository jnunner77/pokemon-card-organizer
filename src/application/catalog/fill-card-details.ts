import { type DetailsMatch, type LookupFound, type LookupResult, lastMatch, wantsDetails } from '#domain/catalog/details.ts';
import { catalogLanguage, matchLanguage } from '#domain/catalog/japanese.ts';
import { changeCard, readCard } from './cards.ts';
import type { CatalogDeps } from './deps.ts';
import { JapaneseNotReady, messageOf } from './errors.ts';
import type { CardFinder } from './finder.ts';
import { JapaneseCardFinder } from './japanese-finder.ts';
import { CardMatcher } from './matcher.ts';
import { SourceUnavailable } from './ports.ts';

export interface FillCardDetailsInput {
  readonly cardId: string;
  /** Look it up even if it was looked up this week. */
  readonly force?: boolean | undefined;
  /** The TCGdex card the person chose for it ("this is my card"). */
  readonly chosen?: string | undefined;
}

/** How the lookup ended; skipped when the card has nothing to fill (or no longer exists). */
export type FillResult = LookupResult | 'skipped';

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Fill a card's empty set, set code, rarity, illustrator and release date when exactly one card
 * matches, and record what happened on the card. A card already matched is fetched by its TCGdex
 * id instead of searched again. The card is read again before it's saved, so nothing typed
 * meanwhile is lost.
 */
export class FillCardDetails {
  readonly #deps: Pick<CatalogDeps, 'database' | 'japanese' | 'cards' | 'unitOfWork' | 'events' | 'clock'>;
  readonly #matcher: CardMatcher;
  readonly #japanese: JapaneseCardFinder | null;

  constructor(deps: Pick<CatalogDeps, 'database' | 'japanese' | 'cards' | 'unitOfWork' | 'events' | 'clock'>) {
    this.#deps = deps;
    this.#matcher = new CardMatcher(deps.database);
    this.#japanese = deps.japanese ? new JapaneseCardFinder(deps.japanese.catalog, deps.japanese.database) : null;
  }

  async execute(input: FillCardDetailsInput): Promise<FillResult> {
    const deps = this.#deps;
    const now = deps.clock.now();
    const card = await readCard(deps, input.cardId);
    if (!card || (!input.chosen && !wantsDetails(card, now, input.force ?? false))) return 'skipped';
    // English (or no language) cards are looked up in TCGdex, Japanese ones in the Japanese index;
    // other languages aren't, unless the person chose a TCGdex card for it.
    const catalog = catalogLanguage(card['language']);
    const language = catalog ?? 'en';
    const finder: CardFinder | null = catalog === 'ja' ? this.#japanese : catalog === 'en' || input.chosen ? this.#matcher : null;
    if (!finder) return 'skipped';
    let found: LookupFound;
    try {
      const name = String(card['name'] ?? '');
      const number = String(card['number'] ?? '');
      const hints = { set: text(card['set']), setCode: text(card['setCode']) };
      const prev = lastMatch(card);
      // A match the person chose, or one made with the current checks, is fetched by its id. An
      // automatic match from older checks is looked up again (they could take a card from another set).
      // A match from the other language's catalog doesn't count: the card is searched for again.
      const earlier = prev.id && matchLanguage(prev.id) === language && (prev.chosen || prev.current) ? prev.id : undefined;
      const known = input.chosen ?? earlier;
      let matches: readonly DetailsMatch[] = known ? [await finder.match(known)] : await finder.lookup(name, number, hints);
      // Looked up again without a sure answer: the older match stays, unless it's from another set
      // than the one the card is filed under.
      if (!known && prev.id && matchLanguage(prev.id) === language && matches.length !== 1) {
        const old = await finder.match(prev.id);
        if (!(await finder.filing(old, card['set'])).filedUnder) matches = [old];
      }
      const [only] = matches;
      if (only && matches.length === 1) {
        const chosen = !!input.chosen || (prev.chosen && only.id === prev.id);
        // Checked against the set it's filed under now.
        const filedUnder = (await readCard(deps, input.cardId))?.['set'];
        found = { kind: 'one', match: only, filing: await finder.filing(only, filedUnder), chosen };
      } else if (matches.length) found = { kind: 'several', options: matches };
      else found = { kind: 'none', suggest: await finder.suggest(name, number, hints) };
    } catch (error) {
      // The Japanese index hasn't finished its first build: nothing is recorded, the card is tried again later.
      if (error instanceof JapaneseNotReady) return 'skipped';
      // TCGdex no longer having the card (404): it's searched for by name and number again.
      const gone = error instanceof SourceUnavailable && error.status === 404;
      found = { kind: 'failed', message: error instanceof Error ? error.message.slice(0, 300) : messageOf(error), gone };
    }
    return (await changeCard(deps, input.cardId, (c) => c.recordLookup(found, now))) ?? 'skipped';
  }
}
