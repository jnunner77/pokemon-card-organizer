import { type DetailsMatch, type LookupFound, type LookupResult, lastMatch, wantsDetails } from '#domain/catalog/details.ts';
import { changeCard, readCard } from './cards.ts';
import type { CatalogDeps } from './deps.ts';
import { messageOf } from './errors.ts';
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
  readonly #deps: Pick<CatalogDeps, 'database' | 'cards' | 'unitOfWork' | 'events' | 'clock'>;
  readonly #matcher: CardMatcher;

  constructor(deps: Pick<CatalogDeps, 'database' | 'cards' | 'unitOfWork' | 'events' | 'clock'>) {
    this.#deps = deps;
    this.#matcher = new CardMatcher(deps.database);
  }

  async execute(input: FillCardDetailsInput): Promise<FillResult> {
    const deps = this.#deps;
    const now = deps.clock.now();
    const card = await readCard(deps, input.cardId);
    if (!card || (!input.chosen && !wantsDetails(card, now, input.force ?? false))) return 'skipped';
    let found: LookupFound;
    try {
      const m = this.#matcher;
      const name = String(card['name'] ?? '');
      const number = String(card['number'] ?? '');
      const hints = { set: text(card['set']), setCode: text(card['setCode']) };
      const prev = lastMatch(card);
      // A match the person chose, or one made with the current checks, is fetched by its id. An
      // automatic match from older checks is looked up again (they could take a card from another set).
      const known = input.chosen ?? (prev.id && (prev.chosen || prev.current) ? prev.id : undefined);
      let matches: readonly DetailsMatch[] = known ? [await m.match(known)] : await m.lookup(name, number, hints);
      // Looked up again without a sure answer: the older match stays, unless it's from another set
      // than the one the card is filed under.
      if (!known && prev.id && matches.length !== 1) {
        const old = await m.match(prev.id);
        if (!(await m.filing(old, card['set'])).filedUnder) matches = [old];
      }
      const [only] = matches;
      if (only && matches.length === 1) {
        const chosen = !!input.chosen || (prev.chosen && only.id === prev.id);
        // Checked against the set it's filed under now.
        const filedUnder = (await readCard(deps, input.cardId))?.['set'];
        found = { kind: 'one', match: only, filing: await m.filing(only, filedUnder), chosen };
      } else if (matches.length) found = { kind: 'several', options: matches };
      else found = { kind: 'none', suggest: await m.suggest(name, number, hints) };
    } catch (error) {
      // TCGdex no longer having the card (404): it's searched for by name and number again.
      const gone = error instanceof SourceUnavailable && error.status === 404;
      found = { kind: 'failed', message: error instanceof Error ? error.message.slice(0, 300) : messageOf(error), gone };
    }
    return (await changeCard(deps, input.cardId, (c) => c.recordLookup(found, now))) ?? 'skipped';
  }
}
