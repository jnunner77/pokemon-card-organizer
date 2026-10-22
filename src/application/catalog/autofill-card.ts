import { cardLabel, lastFilled } from '#domain/catalog/details.ts';
import { changeCard, readCard } from './cards.ts';
import type { CatalogDeps } from './deps.ts';
import type { FillCardDetails } from './fill-card-details.ts';

export interface AutofillCardInput {
  readonly cardId: string;
  /** It was a different card before (a CSV row replaced it, or its name or number was edited). */
  readonly changed: boolean;
}

/** What the price update did with the card, in words for the log. */
const OUTCOME: Readonly<Record<string, string>> = {
  updated: 'price and picture found',
  needsMatch: 'no certain match on the price sites; choose one in its drawer',
  noPrice: 'matched, but no price yet',
  failed: 'the price sites did not answer; the daily run tries again',
  skipped: 'skipped',
  off: 'automatic pricing is off for it',
};

/**
 * A new (or changed) card fills itself in: its empty details are looked up, then its price and
 * official picture, instead of waiting for the next morning's run.
 */
export class AutofillCard {
  readonly #deps: Pick<CatalogDeps, 'cards' | 'unitOfWork' | 'events' | 'clock' | 'pricing' | 'log'>;
  readonly #fill: Pick<FillCardDetails, 'execute'>;

  constructor(deps: Pick<CatalogDeps, 'cards' | 'unitOfWork' | 'events' | 'clock' | 'pricing' | 'log'> & { readonly fillCard: Pick<FillCardDetails, 'execute'> }) {
    this.#deps = deps;
    this.#fill = deps.fillCard;
  }

  async execute(input: AutofillCardInput): Promise<void> {
    const deps = this.#deps;
    const { cardId, changed } = input;
    const card = await readCard(deps, cardId);
    if (!card) return;
    const label = cardLabel(card);
    // What was found for the card it was (its match, release date, an automatic price match) goes.
    if (changed) await changeCard(deps, cardId, (c) => c.forgetFormerCard(deps.clock.now()));
    const result = await this.#fill.execute({ cardId, force: changed });
    if (result === 'filled') deps.log.info(`Filled in ${label}: ${lastFilled((await readCard(deps, cardId)) ?? {}).join(', ')} from TCGdex`);
    // Without automatic prices, only its details; during the daily run, that run prices it.
    const pricing = deps.pricing;
    if (!pricing?.canPriceNow()) return;
    const outcome = await pricing.updateCard(cardId);
    deps.log.info(`${changed ? 'Changed' : 'New'} card ${label}: ${OUTCOME[outcome] ?? outcome}`);
  }
}
