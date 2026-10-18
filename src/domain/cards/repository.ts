import type { Card, CardId } from './card.ts';

export interface CardRepository {
  findById(id: CardId): Promise<Card | undefined>;
  /** Every card in the collection (it is a collector's cards, not a warehouse). */
  all(): Promise<readonly Card[]>;
  save(card: Card): Promise<void>;
  delete(card: Card): Promise<void>;
}
