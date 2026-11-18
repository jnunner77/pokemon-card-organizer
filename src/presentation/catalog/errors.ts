import type { ChooseMatchError } from '#application/catalog/choose-match.ts';
import type { CreateMasterSetError } from '#application/catalog/create-master-set.ts';
import type { CardDatabaseUnavailable, JapaneseUnavailable } from '#application/catalog/errors.ts';
import type { ShowAnyCardError } from '#application/catalog/show-any-card.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

/** Card lookups are turned off on this server (CARD_LOOKUPS=off). */
export const LOOKUPS_OFF: Failure = { status: 503, code: 'invalid_argument', message: 'Card lookups are turned off on this server.' };
/** The same, for Find a card → Any card. */
export const ANY_CARD_OFF: Failure = { status: 503, code: 'unavailable', message: 'Card lookups are turned off on this server.' };

export const NO_SUCH_CARD: Failure = { status: 404, code: 'not_found', message: 'That card no longer exists.' };
export const NOT_IN_DATABASE: Failure = { status: 404, code: 'not_found', message: 'No such card in the card database.' };

const JAPANESE_OFF: Failure = { status: 503, code: 'unavailable', message: 'Japanese card lookups are turned off on this server.' };

/** The card database didn't answer, in its own words ("Couldn't reach api.tcgdex.net: …"), or the Japanese catalog isn't there yet. */
export function lookupFailure(e: CardDatabaseUnavailable | JapaneseUnavailable): Failure {
  switch (e.code) {
    case 'CARD_DATABASE_UNAVAILABLE':
      return { status: 502, code: 'upstream_error', message: e.message };
    case 'JAPANESE_LOOKUPS_OFF':
      return JAPANESE_OFF;
    case 'JAPANESE_CATALOG_NOT_READY':
      return {
        status: 503,
        code: 'unavailable',
        message:
          e.total === 0
            ? "TCGplayer's Japanese catalog is about to be downloaded. Try again in a few minutes."
            : `TCGplayer's Japanese catalog is still being downloaded (${e.done} of ${e.total} sets). Try again in a few minutes.`,
      };
    default:
      return assertNever(e);
  }
}

export function chooseFailure(e: ChooseMatchError): Failure {
  switch (e.code) {
    case 'CARD_NOT_FOUND':
      return NO_SUCH_CARD;
    case 'INVALID_MATCH':
      return badRequest('Give the TCGdex card id.');
    case 'WRONG_LANGUAGE':
      return badRequest("That card is from another language's catalog than this card.");
    case 'JAPANESE_LOOKUPS_OFF':
    case 'JAPANESE_CATALOG_NOT_READY':
      return lookupFailure(e);
    case 'LOOKUP_FAILED':
      return { status: 502, code: 'upstream_error', message: "The card database didn't answer. Try again." };
    default:
      return assertNever(e);
  }
}

export function anyCardFailure(e: ShowAnyCardError): Failure {
  switch (e.code) {
    case 'NO_SUCH_CARD':
      return NOT_IN_DATABASE;
    case 'CARD_DATABASE_UNAVAILABLE':
    case 'JAPANESE_LOOKUPS_OFF':
    case 'JAPANESE_CATALOG_NOT_READY':
      return lookupFailure(e);
    default:
      return assertNever(e);
  }
}

export function masterSetFailure(e: CreateMasterSetError): Failure {
  switch (e.code) {
    case 'SET_NOT_FOUND':
      return { status: 404, code: 'not_found', message: `No set called “${e.query}” was found. Pick one from the list.` };
    case 'SET_HAS_NO_CARDS':
      return { status: 404, code: 'not_found', message: `The card database has no cards for ${e.title} yet.` };
    case 'CARD_DATABASE_UNAVAILABLE':
      return { status: 502, code: 'upstream_error', message: "The card database (TCGdex) didn't answer. Try again in a minute." };
    case 'INVALID_DOCUMENT':
      return badRequest(e.message);
    case 'INVALID_ID':
      return badRequest(`Not an id: ${e.id}`);
    default:
      return assertNever(e);
  }
}
