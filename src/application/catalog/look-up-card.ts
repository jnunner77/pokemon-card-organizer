import type { DetailsMatch } from '#domain/catalog/details.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, unavailable } from './errors.ts';
import { CardMatcher } from './matcher.ts';

export interface LookUpCardInput {
  readonly name: string;
  readonly number: string;
  readonly set?: string | undefined;
  readonly setCode?: string | undefined;
}

/** The cards in the card database with this name and number, for the Add card form. */
export class LookUpCard {
  readonly #matcher: CardMatcher;

  constructor(deps: Pick<CatalogDeps, 'database'>) {
    this.#matcher = new CardMatcher(deps.database);
  }

  async execute(input: LookUpCardInput): Promise<Result<{ readonly matches: readonly DetailsMatch[] }, CardDatabaseUnavailable>> {
    try {
      return ok({ matches: await this.#matcher.lookup(input.name, input.number, { set: input.set, setCode: input.setCode }) });
    } catch (error) {
      return err(unavailable(error));
    }
  }
}
