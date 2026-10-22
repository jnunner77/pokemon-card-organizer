import { entriesOf, familyOf, groupPairs, type MasterSet, masterSet, type OrderedEntry, type SetChoice, setChoices, setNamed, type TcgplayerCheck, tcgplayerPrintings } from '#domain/catalog/master-sets.ts';
import type { TcgdexCard, TcgdexSet } from '#domain/catalog/tcgdex.ts';
import type { TcgGroup, TcgGroupContents } from '#domain/catalog/tcgplayer.ts';
import type { CatalogDeps } from './deps.ts';
import { messageOf } from './errors.ts';
import { SourceUnavailable } from './ports.ts';

/** Runs `fn` over `items`, `limit` at a time. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return out;
}

const NOT_ANSWERING = "TCGplayer's catalog (tcgcsv.com) didn't answer";

/**
 * A set's master set from the card database, checked against TCGplayer's catalog. The card
 * database's failures are thrown (SourceUnavailable); TCGplayer's catalog's are noted on the master
 * set instead.
 */
export class MasterSetFinder {
  readonly #deps: Pick<CatalogDeps, 'database' | 'tcgplayer'>;

  constructor(deps: Pick<CatalogDeps, 'database' | 'tcgplayer'>) {
    this.#deps = deps;
  }

  /** The sets to choose from. */
  async sets(): Promise<SetChoice[]> {
    const db = this.#deps.database;
    const pocket = await db.pocketSets();
    return setChoices(await db.sets(), pocket);
  }

  /**
   * Every card of a set, named as TCGdex names it ("151", "Ascended Heroes") or by its id
   * ("sv03.5"), in every variant: trainers and energy too, secret rares, and its reprint sub-sets
   * (Trainer Gallery, Galarian Gallery, Shiny Vault, Classic Collection) after its own cards, then
   * checked against TCGplayer's catalog. Null when no set has that name.
   */
  async find(query: string): Promise<MasterSet | null> {
    const db = this.#deps.database;
    const sets = await this.sets();
    const set = setNamed(sets, query);
    if (!set) return null;
    const family = familyOf(set, sets);
    const briefs = [];
    for (const x of family) briefs.push(...((await db.set(x.id)).cards ?? []));
    const full = await pool(briefs, 6, (b) => db.card(b.id));
    const found = await pool(family, 6, (x) => db.set(x.id).catch(() => null));
    const infos = new Map<string, TcgdexSet | null>(family.map((x, i) => [x.id, found[i] ?? null]));
    const entries = entriesOf(full, infos);
    const tcgplayer = await this.#checkTcgplayer({ family, set, infos, full }, entries);
    return masterSet(set, family, entries, tcgplayer);
  }

  /**
   * Checks the set against TCGplayer's catalog, set by set, adding to `entries` the printings
   * TCGplayer lists that TCGdex has no variant for.
   */
  async #checkTcgplayer(o: { readonly family: readonly SetChoice[]; readonly set: SetChoice; readonly infos: ReadonlyMap<string, TcgdexSet | null>; readonly full: readonly TcgdexCard[] }, entries: OrderedEntry[]): Promise<TcgplayerCheck> {
    const catalog = this.#deps.tcgplayer;
    if (!catalog) return { checked: false, error: "TCGplayer's catalog isn't used on this server." };
    // Someone asked for it now: try tcgcsv.com even if a price update found it failing.
    catalog.reset();
    let groups: readonly TcgGroup[];
    try {
      groups = await catalog.groupList();
    } catch (error) {
      return { checked: false, error: `${NOT_ANSWERING}: ${messageOf(error)}` };
    }
    const pairs = groupPairs(groups, o.family, o.set);
    const named: string[] = [];
    let added = 0;
    for (const pair of pairs) {
      let data: TcgGroupContents;
      try {
        data = await catalog.group(pair.g.groupId);
      } catch (error) {
        if (error instanceof SourceUnavailable) return { checked: false, error: `${NOT_ANSWERING}: ${error.message}` };
        throw error;
      }
      named.push(pair.g.name);
      const more = tcgplayerPrintings({ ...o, pairs, entries, added }, pair, data);
      entries.push(...more);
      added += more.length;
    }
    return named.length ? { checked: true, added, sets: named } : { checked: false, error: `TCGplayer's catalog has no set called ${o.set.name}.` };
  }
}
