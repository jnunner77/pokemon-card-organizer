import { isCardDatabaseId } from '#domain/catalog/tcgdex.ts';
import type { Fields } from '#domain/ledger/document.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { readCard } from './cards.ts';
import type { CatalogDeps } from './deps.ts';
import type { FillCardDetails, FillResult } from './fill-card-details.ts';

export interface ChooseMatchInput {
  readonly cardId: string;
  /** The TCGdex card id the person chose, as the page sent it. */
  readonly matchId: unknown;
}

export type ChooseMatchError = { readonly code: 'CARD_NOT_FOUND' } | { readonly code: 'INVALID_MATCH' } | { readonly code: 'LOOKUP_FAILED' };

/**
 * "This is my card": one of several matches, or a name suggested for a card not found. The card
 * takes that card's details (where it has blanks), and is priced, as its set is known now.
 */
export class ChooseMatch {
  readonly #deps: Pick<CatalogDeps, 'cards' | 'unitOfWork' | 'events' | 'pricing'>;
  readonly #fill: Pick<FillCardDetails, 'execute'>;

  constructor(deps: Pick<CatalogDeps, 'cards' | 'unitOfWork' | 'events' | 'pricing'> & { readonly fillCard: Pick<FillCardDetails, 'execute'> }) {
    this.#deps = deps;
    this.#fill = deps.fillCard;
  }

  async execute(input: ChooseMatchInput): Promise<Result<{ readonly result: FillResult; readonly card: Fields | undefined }, ChooseMatchError>> {
    if (!(await readCard(this.#deps, input.cardId))) return err({ code: 'CARD_NOT_FOUND' });
    if (!isCardDatabaseId(input.matchId)) return err({ code: 'INVALID_MATCH' });
    const result = await this.#fill.execute({ cardId: input.cardId, force: true, chosen: input.matchId });
    const card = await readCard(this.#deps, input.cardId);
    if (result === 'error') return err({ code: 'LOOKUP_FAILED' });
    const pricing = this.#deps.pricing;
    if (pricing?.canPriceNow()) void pricing.updateCard(input.cardId).catch(() => undefined);
    return ok({ result, card });
  }
}
