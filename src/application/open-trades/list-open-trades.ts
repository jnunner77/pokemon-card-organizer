import type { OpenTradeDeps } from './deps.ts';
import type { OpenTradeView } from './ports.ts';
import { viewOfOpenTrade } from './views.ts';

/** The open trades, by number. */
export class ListOpenTrades {
  readonly #deps: Pick<OpenTradeDeps, 'shelf'>;

  constructor(deps: Pick<OpenTradeDeps, 'shelf'>) {
    this.#deps = deps;
  }

  async execute(): Promise<readonly OpenTradeView[]> {
    const book = await this.#deps.shelf.read();
    return book.trades.map(viewOfOpenTrade).sort((a, b) => a.number - b.number);
  }
}
