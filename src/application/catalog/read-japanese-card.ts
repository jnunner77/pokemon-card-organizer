import { type JapaneseEntry, localOf, parseJapaneseMatchId } from '#domain/catalog/japanese.ts';
import { mapRarity } from '#domain/catalog/rarity.ts';
import { tcgImage } from '#domain/catalog/tcgplayer.ts';
import type { CatalogDeps } from './deps.ts';
import { JapaneseNotReady } from './errors.ts';
import { japaneseArtist } from './japanese-finder.ts';
import { SourceUnavailable } from './ports.ts';
import type { AnyCardDetails } from './read-any-card.ts';

type Japanese = NonNullable<CatalogDeps['japanese']>;

/**
 * A Japanese card from the index with its details as the page shows them (without printings).
 * Throws SourceUnavailable (404) when the index has no such card, and JapaneseNotReady while the
 * first build isn't done.
 */
export async function readJapaneseCard(japanese: Japanese, id: string): Promise<{ readonly entry: JapaneseEntry; readonly details: Omit<AnyCardDetails, 'printings'> }> {
  const p = parseJapaneseMatchId(id);
  const entry = p ? japanese.catalog.entry(p.groupId, p.productId) : null;
  if (!entry) {
    if (!japanese.catalog.readiness().ready) throw new JapaneseNotReady();
    throw new SourceUnavailable("That card isn't in TCGplayer's Japanese catalog any more.", 404);
  }
  const e = entry;
  const artist = await japaneseArtist(japanese.database, e);
  return {
    entry: e,
    details: {
      id,
      name: e.card.name + (e.card.variant ? ` (${e.card.variant})` : ''),
      number: localOf(e.card.number),
      total: e.size,
      set: e.set.name,
      setCode: e.set.code,
      rarity: mapRarity(e.card.rarity),
      artist,
      released: e.set.released,
      image: tcgImage(e.card.productId, 1000),
      thumb: tcgImage(e.card.productId, 200),
    },
  };
}
