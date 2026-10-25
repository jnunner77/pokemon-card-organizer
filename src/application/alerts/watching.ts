import { activeTargets } from '#domain/cards/watch.ts';
import type { LedgerReader } from '../ledger/ledger-reader.ts';

/** How many cards are watched to buy and to sell. */
export async function watching(ledger: LedgerReader): Promise<{ readonly buy: number; readonly sell: number }> {
  const { cards } = await ledger.read();
  let buy = 0;
  let sell = 0;
  for (const c of cards) {
    const t = activeTargets(c);
    if (t.buy !== null) buy++;
    if (t.sell !== null) sell++;
  }
  return { buy, sell };
}
