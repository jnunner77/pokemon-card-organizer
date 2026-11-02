import type { ActivityLog, Clock } from '../ports.ts';
import type { OpenTradeNews, OpenTradeShelf } from './ports.ts';

export interface OpenTradeDeps {
  readonly shelf: OpenTradeShelf;
  readonly news: OpenTradeNews;
  readonly clock: Clock;
  readonly activity: ActivityLog;
}
