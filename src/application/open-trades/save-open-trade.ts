import { documentId, type InvalidId } from '#domain/ledger/ids.ts';
import { checkOpenTradeContent, type OpenTradeError, type OpenTradeId, saveOpenTrade } from '#domain/open-trades/open-trade.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { OpenTradeDeps } from './deps.ts';
import type { OpenTradeView } from './ports.ts';
import { viewOfOpenTrade } from './views.ts';

export type SaveOpenTradeError = InvalidId | OpenTradeError;

export interface SaveOpenTradeInput {
  readonly actor: string;
  readonly id: string;
  readonly baseVersion: number;
  readonly content: unknown;
}

/** Create or replace an open trade, if the device saw its latest version. */
export class SaveOpenTrade {
  readonly #deps: OpenTradeDeps;

  constructor(deps: OpenTradeDeps) {
    this.#deps = deps;
  }

  async execute(input: SaveOpenTradeInput): Promise<Result<OpenTradeView, SaveOpenTradeError>> {
    const id = documentId<OpenTradeId>(input.id);
    if (!id.ok) return id;
    const content = checkOpenTradeContent(input.content);
    if (!content.ok) return content;
    const at = this.#deps.clock.now().toISOString();
    const saved = await this.#deps.shelf.change((draft): Result<{ view: OpenTradeView; created: boolean; changed: boolean }, OpenTradeError> => {
      const r = saveOpenTrade(draft, { id: id.value, baseVersion: input.baseVersion, content: content.value, by: input.actor, at });
      if (!r.ok) return err(r.error);
      draft.changed = r.value.changed;
      return ok({ view: viewOfOpenTrade(r.value.trade), created: r.value.created, changed: r.value.changed });
    });
    if (!saved.ok) return saved;
    const { view, created, changed } = saved.value;
    if (changed) this.#deps.news.publish({ id: view.id, trade: view });
    // The customer's name is never logged.
    if (created) this.#deps.activity.info(`${input.actor} opened Trade ${view.number}`, { by: input.actor, trade: view.number });
    return ok(view);
  }
}
