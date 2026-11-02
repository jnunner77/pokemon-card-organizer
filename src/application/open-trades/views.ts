import type { OpenTrade } from '#domain/open-trades/open-trade.ts';
import type { OpenTradeView } from './ports.ts';

export type { OpenTradeView } from './ports.ts';

export const viewOfOpenTrade = (t: OpenTrade): OpenTradeView => ({
  id: t.id,
  number: t.number,
  customer: t.customer,
  dealer: t.dealer,
  mine: t.mine,
  version: t.version,
  updatedAt: t.updatedAt,
  updatedBy: t.updatedBy,
});
