import type { ArrangeBinderError } from '#application/ledger/arrange-binder.ts';
import type { ChangePriceEntriesError } from '#application/ledger/change-price-entries.ts';
import type { AddressError } from '#application/ledger/documents.ts';
import type { MergeDocumentError } from '#application/ledger/merge-document.ts';
import type { PutDocumentError } from '#application/ledger/put-document.ts';
import { singular } from '#domain/ledger/document.ts';
import { DOCUMENT_ID_RULE } from '#domain/ledger/ids.ts';
import type { PlaceError } from '#domain/ledger/place.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

// From each ledger use case's errors to the HTTP answer. Every switch is exhaustive: a new error
// code fails the build until someone decides its status and words.

const notFound = (message: string): Failure => ({ status: 404, code: 'not_found', message });
const conflict = (message: string): Failure => ({ status: 409, code: 'conflict', message });

export function documentFailure(e: AddressError | PutDocumentError | MergeDocumentError): Failure {
  switch (e.code) {
    case 'NO_SUCH_COLLECTION':
      return notFound('No such collection');
    case 'INVALID_ID':
      return badRequest(DOCUMENT_ID_RULE);
    case 'SETTING_BELONGS_TO_SERVER':
      return { status: 403, code: 'forbidden', message: 'That setting belongs to the server.' };
    case 'INVALID_DOCUMENT':
      return badRequest(e.message);
    case 'DOCUMENT_NOT_FOUND':
      return notFound(`No ${singular(e.collection)} with id ${e.id}`);
    default:
      return assertNever(e);
  }
}

export function priceEntriesFailure(e: ChangePriceEntriesError): Failure {
  switch (e.code) {
    case 'INVALID_ID':
      return badRequest(DOCUMENT_ID_RULE);
    case 'PRICES_SENT_AS_FIELDS':
      return badRequest('Price entries are sent as add, update and remove.');
    case 'CARD_NOT_FOUND':
      return notFound('That card no longer exists.');
    case 'PRICE_ENTRY_GONE':
      return conflict('A price entry was changed or removed meanwhile, so nothing was saved. Try again.');
    case 'INVALID_DOCUMENT':
      return badRequest(e.message);
    default:
      return assertNever(e);
  }
}

export function arrangeFailure(e: ArrangeBinderError): Failure {
  switch (e.code) {
    case 'BINDER_NOT_FOUND':
      return notFound('That binder no longer exists.');
    case 'ARRANGEMENT_UNREADABLE':
      return badRequest('Send each card with its page and pocket.');
    case 'BINDER_IS_CASE':
      return badRequest('A display case has no pages or pockets to arrange.');
    case 'BINDER_CHANGED':
      return conflict('The binder changed meanwhile (a card was added, moved or removed), so nothing moved. Try again.');
    case 'POCKET_SHARED':
      return badRequest('Two cards were given the same pocket.');
    case 'POCKET_PAST_PAGE':
      return badRequest(`This binder's pages have ${e.pockets} pockets.`);
    case 'INVALID_DOCUMENT':
      return badRequest(e.message);
    default:
      return assertNever(e);
  }
}

export function placeFailure(e: PlaceError): Failure {
  switch (e.code) {
    case 'CARD_GIVEN_TWICE':
      return badRequest('A card was given twice.');
    case 'CARD_DELETED_MEANWHILE':
      return conflict('A card was deleted meanwhile, so nothing moved. Try again.');
    case 'BINDER_GONE':
      return conflict('That binder no longer exists, so nothing moved.');
    case 'CASE_HAS_NO_POCKETS':
      return badRequest(`${e.binderName ?? 'That display case'} is a display case: it has no pages or pockets.`);
    case 'POCKET_REQUIRED':
      return badRequest('Choose a page and pocket in that binder.');
    case 'POCKET_PAST_PAGE':
      return badRequest('That pocket is past the end of the page.');
    case 'POCKET_TAKEN':
      return conflict('A pocket was filled meanwhile, so nothing moved. Try again.');
    case 'INVALID_DOCUMENT':
      return badRequest(e.message);
    default:
      return assertNever(e);
  }
}
