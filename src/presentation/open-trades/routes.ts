import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Caller, requireRole, type Role } from '#application/access.ts';
import type { DiscardOpenTrade } from '#application/open-trades/discard-open-trade.ts';
import type { ListOpenTrades } from '#application/open-trades/list-open-trades.ts';
import type { SaveOpenTrade } from '#application/open-trades/save-open-trade.ts';
import { DOCUMENT_ID_RULE } from '#domain/ledger/ids.ts';
import { readJsonBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { accessFailure, badRequest, bodyFailure } from '../http/errors.ts';
import { sendFailure, sendJson, sendNoContent } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { openTradeFailure } from './errors.ts';
import { openTradeSave } from './parse.ts';

export interface OpenTradeRouteDeps {
  readonly identify: CallerResolver;
  readonly list: Pick<ListOpenTrades, 'execute'>;
  readonly save: Pick<SaveOpenTrade, 'execute'>;
  readonly discard: Pick<DiscardOpenTrade, 'execute'>;
}

/** Open trades, shared by everyone who can edit: routes relative to /api. */
export function openTradeRoutes(deps: OpenTradeRouteDeps): Router {
  const allowed = (req: IncomingMessage, res: ServerResponse, needs: Role): Caller | null => {
    const r = requireRole(deps.identify(req), needs);
    if (r.ok) return r.value;
    sendFailure(res, accessFailure(r.error));
    return null;
  };
  const body = async (req: IncomingMessage, res: ServerResponse): Promise<{ value: unknown } | null> => {
    const r = await readJsonBody(req);
    if (r.ok) return { value: r.value };
    sendFailure(res, bodyFailure(r.error));
    return null;
  };

  return new Router()
    .add('GET', '/open-trades', async (req, res) => {
      if (!allowed(req, res, 'editor')) return;
      req.resume();
      sendJson(res, 200, { trades: await deps.list.execute() });
    })
    .add('PUT', '/open-trades/:id', async (req, res, p) => {
      const caller = allowed(req, res, 'editor');
      if (!caller) return;
      const raw = await body(req, res);
      if (!raw) return;
      const save = openTradeSave(raw.value);
      if (!save) return sendFailure(res, badRequest('Send the trade with its baseVersion, customer, dealer and mine.'));
      const r = await deps.save.execute({ actor: caller.name, id: p['id'] ?? '', ...save });
      if (r.ok) sendJson(res, 200, r.value);
      else sendFailure(res, openTradeFailure(r.error));
    })
    .add('DELETE', '/open-trades/:id', async (req, res, p) => {
      const caller = allowed(req, res, 'editor');
      if (!caller) return;
      req.resume();
      const r = await deps.discard.execute({ actor: caller.name, id: p['id'] ?? '' });
      if (r.ok) sendNoContent(res);
      else sendFailure(res, badRequest(DOCUMENT_ID_RULE));
    });
}
