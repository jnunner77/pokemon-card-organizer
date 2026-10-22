import { lookedUp, outdated, wantsDetails } from '#domain/catalog/details.ts';
import { readCards } from './cards.ts';
import type { CatalogDeps } from './deps.ts';
import type { FillEveryCard } from './fill-every-card.ts';

/**
 * Look up cards again after an update that adds checks: cards looked up before the current checks
 * (release dates, the set a card is filed under, suggested names), and cards never looked up
 * (complete before details were filled in). Runs Fill in missing details when there are any;
 * how many cards it looks at.
 */
export class BackfillDetails {
  readonly #deps: Pick<CatalogDeps, 'cards' | 'unitOfWork' | 'events' | 'clock' | 'log'>;
  readonly #fillEvery: Pick<FillEveryCard, 'execute' | 'running'>;

  constructor(deps: Pick<CatalogDeps, 'cards' | 'unitOfWork' | 'events' | 'clock' | 'log'> & { readonly fillEvery: Pick<FillEveryCard, 'execute' | 'running'> }) {
    this.#deps = deps;
    this.#fillEvery = deps.fillEvery;
  }

  async execute(): Promise<number> {
    const now = this.#deps.clock.now();
    const need = (await readCards(this.#deps)).filter((c) => wantsDetails(c.fields, now) && (outdated(c.fields) || !lookedUp(c.fields))).length;
    if (!need || this.#fillEvery.running) return 0;
    this.#deps.log.info(`${need} cards to look up or check again after an update`);
    return (await this.#fillEvery.execute({ force: false })).cards;
  }
}
