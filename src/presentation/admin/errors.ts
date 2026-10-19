import type { PriceChartingUnavailable, TokenCheckFailed, TokenRefused } from '#application/admin/pricecharting-access.ts';
import type { InvalidPageError } from '#domain/admin/page-errors.ts';
import type { InvalidSeenMark } from '#domain/admin/problems.ts';
import type { InvalidSetting } from '#domain/admin/settings.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

export function adminFailure(e: InvalidSetting | InvalidSeenMark | InvalidPageError | PriceChartingUnavailable | TokenRefused | TokenCheckFailed): Failure {
  switch (e.code) {
    case 'INVALID_SETTING':
    case 'INVALID_SEEN_MARK':
    case 'INVALID_PAGE_ERROR':
      return badRequest(e.message);
    case 'PRICECHARTING_UNAVAILABLE':
      return badRequest('PriceCharting prices are not available on this server.');
    case 'TOKEN_REFUSED':
      return badRequest("PriceCharting didn't accept that token. Check you copied all of it from its Subscription page (API/Download).");
    case 'TOKEN_CHECK_FAILED':
      return { status: 502, code: 'upstream_error', message: `Couldn't check the token with PriceCharting: ${e.message}. Try again.` };
    default:
      return assertNever(e);
  }
}
