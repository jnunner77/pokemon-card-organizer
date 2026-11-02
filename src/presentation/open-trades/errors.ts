import type { SaveOpenTradeError } from '#application/open-trades/save-open-trade.ts';
import { DOCUMENT_ID_RULE } from '#domain/ledger/ids.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

export function openTradeFailure(e: SaveOpenTradeError): Failure {
  switch (e.code) {
    case 'INVALID_ID':
      return badRequest(DOCUMENT_ID_RULE);
    case 'INVALID_OPEN_TRADE':
      return badRequest(e.message);
    case 'TOO_MANY_OPEN_TRADES':
      return { status: 409, code: 'too_many_trades', message: `At most ${e.max} trades can be open at once: record or discard one first.` };
    case 'OPEN_TRADE_CHANGED':
      return { status: 409, code: 'trade_changed', message: "This trade was changed on another device meanwhile, so it wasn't saved." };
    case 'OPEN_TRADE_CLOSED':
      return { status: 410, code: 'trade_closed', message: 'This trade was recorded or discarded on another device.' };
    default:
      return assertNever(e);
  }
}
