import type { TradeChange } from '#domain/ledger/trade.ts';
import { ok } from '#shared/result.ts';
import type { LedgerDeps } from './deps.ts';
import { type DocumentView, viewOf } from './ledger-reader.ts';

/** What a trade changed, as the page applies it: the cards saved and the ids of those deleted. */
export interface TradeView {
  readonly cards: readonly DocumentView[];
  readonly deleted: readonly string[];
}

/** Save what recording or undoing a trade changed, inside its unit of work. */
export async function saveTrade(deps: LedgerDeps, change: TradeChange) {
  for (const card of change.saved) await deps.cards.save(card);
  for (const card of change.deleted) await deps.cards.delete(card);
  const events = [...change.saved, ...change.deleted].flatMap((c) => c.pullEvents());
  const value: TradeView = { cards: change.saved.map((c) => viewOf(c.id, c.fields)), deleted: change.deleted.map((c) => String(c.id)) };
  return ok({ value, events });
}
