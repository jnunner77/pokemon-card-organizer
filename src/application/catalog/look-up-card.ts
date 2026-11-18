import type { DetailsMatch } from '#domain/catalog/details.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, JapaneseNotReady, type JapaneseUnavailable, stillBuilding, unavailable } from './errors.ts';
import { JapaneseCardFinder } from './japanese-finder.ts';
import { CardMatcher } from './matcher.ts';

export interface LookUpCardInput {
  readonly name: string;
  readonly number: string;
  readonly set?: string | undefined;
  readonly setCode?: string | undefined;
  /** Which catalog: TCGdex's English one, or TCGplayer's Japanese one. */
  readonly language: 'en' | 'ja';
}

/** The cards in the card database (or the Japanese catalog) with this name and number, for the Add card form. */
export class LookUpCard {
  readonly #matcher: CardMatcher;
  readonly #japanese: { readonly finder: JapaneseCardFinder; readonly catalog: NonNullable<CatalogDeps['japanese']>['catalog'] } | null;

  constructor(deps: Pick<CatalogDeps, 'database' | 'japanese'>) {
    this.#matcher = new CardMatcher(deps.database);
    this.#japanese = deps.japanese ? { finder: new JapaneseCardFinder(deps.japanese.catalog, deps.japanese.database), catalog: deps.japanese.catalog } : null;
  }

  async execute(input: LookUpCardInput): Promise<Result<{ readonly matches: readonly DetailsMatch[] }, CardDatabaseUnavailable | JapaneseUnavailable>> {
    const hints = { set: input.set, setCode: input.setCode };
    if (input.language === 'ja') {
      if (!this.#japanese) return err({ code: 'JAPANESE_LOOKUPS_OFF' });
      try {
        return ok({ matches: await this.#japanese.finder.lookup(input.name, input.number, hints) });
      } catch (error) {
        if (error instanceof JapaneseNotReady) return err(stillBuilding(this.#japanese.catalog));
        return err(unavailable(error));
      }
    }
    try {
      return ok({ matches: await this.#matcher.lookup(input.name, input.number, hints) });
    } catch (error) {
      return err(unavailable(error));
    }
  }
}
