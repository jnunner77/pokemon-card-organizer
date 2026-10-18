import type { AccountError } from '#application/accounts/errors.ts';
import { MAX_TOKEN_NAME } from '#domain/accounts/api-token.ts';
import { MAX_NAME } from '#domain/accounts/person.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

/** Sign-in turned off (AUTH=off): there are no people to administer. */
export const SIGN_IN_OFF: Failure = badRequest('Sign-in is turned off on this server (AUTH=off).');

export function accountFailure(e: AccountError): Failure {
  switch (e.code) {
    case 'WRONG_PASSWORD':
      return { status: 401, code: 'signin', message: 'Wrong username or password.' };
    case 'LOCKED':
      return { status: 429, code: 'rate_limited', message: `Too many wrong passwords. Try again in ${e.minutes} minute${e.minutes === 1 ? '' : 's'}.`, retryAfter: e.minutes * 60 };
    case 'SAME_PASSWORD':
      return badRequest('Choose a password different from the current one.');
    case 'ALREADY_SET_UP':
      return badRequest('The ledger is already set up. Sign in instead.');
    case 'WRONG_SETUP_CODE':
      return { status: 401, code: 'signin', message: 'That setup code is wrong. It is printed in the server log.' };
    case 'INVALID_USERNAME':
      return badRequest('Usernames are 2–32 letters, digits, dots, dashes or underscores');
    case 'NAME_MISSING':
      return badRequest('Enter a name');
    case 'NAME_TOO_LONG':
      return badRequest(`name: Too big: at most ${MAX_NAME} characters`);
    case 'PASSWORD_TOO_LONG':
      return badRequest('Passwords can be at most 200 characters');
    case 'USERNAME_TAKEN':
      return badRequest(`The username "${e.username}" is taken.`);
    case 'PERSON_NOT_FOUND':
      return { status: 404, code: 'not_found', message: 'No such person' };
    case 'PERSON_INACTIVE':
      return badRequest(`${e.username} is inactive`);
    case 'PASSWORD_TOO_SHORT':
      return badRequest(`Use at least ${e.min} characters.`);
    case 'PASSWORD_IS_USERNAME':
      return badRequest("A password can't be the same as the username.");
    case 'PASSWORD_TOO_EASY':
      return badRequest('That password is too easy to guess.');
    case 'LAST_ADMIN':
      return badRequest('Someone else must be an active administrator first.');
    case 'TOKEN_NAME_MISSING':
      return badRequest('Name the token');
    case 'TOKEN_NAME_TOO_LONG':
      return badRequest(`name: Too big: at most ${MAX_TOKEN_NAME} characters`);
    case 'INVALID_TOKEN_DAYS':
    case 'INVALID_SETTING':
      return badRequest(e.message);
    case 'TOKEN_NOT_FOUND':
      return { status: 404, code: 'not_found', message: 'No such token' };
    default:
      return assertNever(e);
  }
}
