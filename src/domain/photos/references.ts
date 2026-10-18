import { isRecord } from '../ledger/document.ts';

/**
 * The photos a ledger (the current one or a copy of it) refers to: each card's own photo (unless it
 * is a small data: URL kept in the card itself, from before uploads) and its official picture.
 */
export function photosReferencedBy(ledger: unknown, into = new Set<string>()): Set<string> {
  const cards = isRecord(ledger) ? ledger['cards'] : undefined;
  if (!isRecord(cards)) return into;
  for (const card of Object.values(cards)) {
    if (!isRecord(card)) continue;
    const { imageId, officialImageId } = card;
    if (typeof imageId === 'string' && !imageId.startsWith('data:')) into.add(imageId);
    if (typeof officialImageId === 'string') into.add(officialImageId);
  }
  return into;
}
