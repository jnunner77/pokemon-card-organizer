import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Caller, requireRole, type Role } from '#application/access.ts';
import type { ArrangeBinder } from '#application/ledger/arrange-binder.ts';
import type { ChangePriceEntries } from '#application/ledger/change-price-entries.ts';
import type { DeleteDocument } from '#application/ledger/delete-document.ts';
import type { MergeDocument } from '#application/ledger/merge-document.ts';
import type { PlaceCards } from '#application/ledger/place-cards.ts';
import type { PutDocument } from '#application/ledger/put-document.ts';
import type { ReadLedger } from '#application/ledger/read-ledger.ts';
import type { RecordTrade } from '#application/ledger/record-trade.ts';
import type { UndoTrade } from '#application/ledger/undo-trade.ts';
import { DOCUMENT_ID_RULE, isDocumentId } from '#domain/ledger/ids.ts';
import { readJsonBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { accessFailure, badRequest, bodyFailure } from '../http/errors.ts';
import { sendFailure, sendJson, sendNoContent } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { arrangeFailure, documentFailure, placeFailure, priceEntriesFailure, tradeFailure } from './errors.ts';
import { arrangement, placements, priceChange, tradeRecord } from './parse.ts';

export interface LedgerRouteDeps {
  readonly identify: CallerResolver;
  readonly readLedger: Pick<ReadLedger, 'execute'>;
  readonly putDocument: Pick<PutDocument, 'execute'>;
  readonly mergeDocument: Pick<MergeDocument, 'execute'>;
  readonly deleteDocument: Pick<DeleteDocument, 'execute'>;
  readonly changePriceEntries: Pick<ChangePriceEntries, 'execute'>;
  readonly arrangeBinder: Pick<ArrangeBinder, 'execute'>;
  readonly placeCards: Pick<PlaceCards, 'execute'>;
  readonly recordTrade: Pick<RecordTrade, 'execute'>;
  readonly undoTrade: Pick<UndoTrade, 'execute'>;
}

/** Binders, cards and settings: the ledger itself, as routes relative to /api. */
export function ledgerRoutes(deps: LedgerRouteDeps): Router {
  /** The caller if they may do this (checked before the request is read), or the refusal sent. */
  const allowed = (req: IncomingMessage, res: ServerResponse, needs: Role): Caller | null => {
    const r = requireRole(deps.identify(req), needs);
    if (r.ok) return r.value;
    sendFailure(res, accessFailure(r.error));
    return null;
  };
  /** The JSON body, or the refusal sent. */
  const body = async (req: IncomingMessage, res: ServerResponse): Promise<{ value: unknown } | null> => {
    const r = await readJsonBody(req);
    if (r.ok) return { value: r.value };
    sendFailure(res, bodyFailure(r.error));
    return null;
  };

  return (
    new Router()
      .add('GET', '/data', async (req, res) => {
        if (!allowed(req, res, 'viewer')) return;
        sendJson(res, 200, await deps.readLedger.execute());
      })

      // A binder, card or the page's settings, created or replaced whole, merged, or deleted.
      .add('PUT', '/docs/:collection/:id', async (req, res, p) => {
        if (!allowed(req, res, 'editor')) return;
        const doc = await body(req, res);
        if (!doc) return;
        const r = await deps.putDocument.execute({ collection: p['collection'] ?? '', id: p['id'] ?? '', doc: doc.value });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, documentFailure(r.error));
      })
      .add('PATCH', '/docs/:collection/:id', async (req, res, p) => {
        if (!allowed(req, res, 'editor')) return;
        const patch = await body(req, res);
        if (!patch) return;
        const r = await deps.mergeDocument.execute({ collection: p['collection'] ?? '', id: p['id'] ?? '', patch: patch.value });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, documentFailure(r.error));
      })
      .add('DELETE', '/docs/:collection/:id', async (req, res, p) => {
        if (!allowed(req, res, 'editor')) return;
        req.resume();
        const r = await deps.deleteDocument.execute({ collection: p['collection'] ?? '', id: p['id'] ?? '' });
        if (r.ok) sendNoContent(res);
        else sendFailure(res, documentFailure(r.error));
      })

      // A card's price entries added, changed or removed by id, with other fields that change with
      // them (a sale's status and location), applied to the card as it is now, so an entry the
      // daily update or someone else added meanwhile is kept.
      .add('POST', '/cards/:id/prices', async (req, res, p) => {
        if (!allowed(req, res, 'editor')) return;
        const raw = await body(req, res);
        if (!raw) return;
        const cardId = p['id'] ?? '';
        if (!isDocumentId(cardId)) return sendFailure(res, badRequest(DOCUMENT_ID_RULE));
        const change = priceChange(raw.value);
        if (!change) return sendFailure(res, badRequest('Send the price entries to add, change or remove.'));
        const r = await deps.changePriceEntries.execute({ cardId, ...change });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, priceEntriesFailure(r.error));
      })

      // Sort a binder: where each of its cards goes, saved all together. With saveLayout, where
      // the cards are now is kept on the binder too, so the page can put them back later.
      .add('POST', '/binders/:id/arrange', async (req, res, p) => {
        const caller = allowed(req, res, 'editor');
        if (!caller) return;
        const raw = await body(req, res);
        if (!raw) return;
        const binderId = p['id'] ?? '';
        if (!isDocumentId(binderId)) return sendFailure(res, arrangeFailure({ code: 'BINDER_NOT_FOUND' }));
        const r = await deps.arrangeBinder.execute({ actor: caller.name, binderId, arrangement: arrangement(raw.value) });
        if (!r.ok) return sendFailure(res, arrangeFailure(r.error));
        const { moved, cards, layoutSaved } = r.value;
        sendJson(res, 200, { moved, cards, ...(layoutSaved !== null ? { layoutSaved } : {}) });
      })

      // Move cards to another binder (or anywhere), all together.
      .add('POST', '/cards/place', async (req, res) => {
        const caller = allowed(req, res, 'editor');
        if (!caller) return;
        const raw = await body(req, res);
        if (!raw) return;
        const moves = placements(raw.value);
        if (!moves) return sendFailure(res, badRequest('Send each card with its binder, page and pocket.'));
        const r = await deps.placeCards.execute({ actor: caller.name, placements: moves });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, placeFailure(r.error));
      })

      // A trade with a dealer recorded all together: my cards traded away, theirs added (or
      // filling placeholders); and undone, by its id.
      .add('POST', '/trades', async (req, res) => {
        const caller = allowed(req, res, 'editor');
        if (!caller) return;
        const raw = await body(req, res);
        if (!raw) return;
        const trade = tradeRecord(raw.value);
        if (!trade) return sendFailure(res, badRequest('Send the trade with its id, the cards given and the cards received.'));
        const r = await deps.recordTrade.execute({ actor: caller.name, ...trade });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, tradeFailure(r.error));
      })
      .add('DELETE', '/trades/:id', async (req, res, p) => {
        const caller = allowed(req, res, 'editor');
        if (!caller) return;
        req.resume();
        const tradeId = p['id'] ?? '';
        if (!isDocumentId(tradeId)) return sendFailure(res, badRequest(DOCUMENT_ID_RULE));
        const r = await deps.undoTrade.execute({ actor: caller.name, tradeId });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, tradeFailure(r.error));
      })
  );
}
