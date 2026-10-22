import type { MasterSet } from '#domain/catalog/master-sets.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { CatalogDeps } from './deps.ts';
import { type CardDatabaseUnavailable, unavailable } from './errors.ts';
import { MasterSetFinder } from './master-set-finder.ts';

export type MasterSetError = { readonly code: 'SET_NOT_FOUND'; readonly query: string } | { readonly code: 'SET_HAS_NO_CARDS'; readonly title: string } | CardDatabaseUnavailable;

/** A set's master set, found by name or id, with at least one card. */
export async function findMasterSet(finder: MasterSetFinder, query: string): Promise<Result<MasterSet, MasterSetError>> {
  let found: MasterSet | null;
  try {
    found = await finder.find(query);
  } catch (error) {
    return err(unavailable(error));
  }
  if (!found) return err({ code: 'SET_NOT_FOUND', query });
  if (!found.entries.length) return err({ code: 'SET_HAS_NO_CARDS', title: found.title });
  return ok(found);
}

/**
 * Every card of a set in every variant, from TCGdex, checked against TCGplayer's catalog, shown
 * before the master set is made. The card databases' answers are remembered (TCGdex's for an hour,
 * TCGplayer's for the day), so making it straight after is quick.
 */
export class PreviewMasterSet {
  readonly #finder: MasterSetFinder;

  constructor(deps: Pick<CatalogDeps, 'database' | 'tcgplayer'>) {
    this.#finder = new MasterSetFinder(deps);
  }

  execute(input: { readonly set: string }): Promise<Result<MasterSet, MasterSetError>> {
    return findMasterSet(this.#finder, input.set);
  }
}
