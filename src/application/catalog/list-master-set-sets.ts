import type { SetChoice } from '#domain/catalog/master-sets.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, unavailable } from './errors.ts';
import { MasterSetFinder } from './master-set-finder.ts';

/** The sets a master set can be made of: TCGdex's English sets, newest last. */
export class ListMasterSetSets {
  readonly #finder: MasterSetFinder;

  constructor(deps: Pick<CatalogDeps, 'database' | 'tcgplayer'>) {
    this.#finder = new MasterSetFinder(deps);
  }

  async execute(): Promise<Result<{ readonly sets: readonly SetChoice[] }, CardDatabaseUnavailable>> {
    try {
      return ok({ sets: await this.#finder.sets() });
    } catch (error) {
      return err(unavailable(error));
    }
  }
}
