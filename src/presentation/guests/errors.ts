import type { GuestNotSignedIn } from '#application/guests/end-guest-visit.ts';
import type { GuestSignInError } from '#application/guests/sign-in-guest.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

/** A guest route without a signed-in guest. */
export const GUEST_SIGN_IN: Failure = { status: 401, code: 'guest_signin', message: 'Your guest visit ended. Sign in again to keep looking.' };
export const GUESTS_UNAVAILABLE: Failure = badRequest('Guest viewing is not available on this server.');
export const NO_PICTURE: Failure = { status: 404, code: 'not_found', message: 'No such picture' };

export function guestFailure(e: GuestSignInError | GuestNotSignedIn): Failure {
  switch (e.code) {
    case 'GUEST_NAME_MISSING':
      return badRequest('Enter your name');
    case 'GUEST_NAME_TOO_LONG':
      return badRequest('Names can be at most 80 characters');
    case 'GUEST_CONTACT_MISSING':
      return badRequest('Enter your phone number or email');
    case 'GUEST_CONTACT_TOO_LONG':
      return badRequest('That is too long for a phone number or email');
    case 'INVALID_EMAIL':
      return badRequest("That email doesn't look right.");
    case 'NOT_PHONE_OR_EMAIL':
      return badRequest('Enter a phone number or an email.');
    case 'INVALID_PHONE':
      return badRequest("That phone number doesn't look right.");
    case 'GUEST_NAME_TAKEN':
      return { status: 409, code: 'guest_taken', message: 'Someone with that name is already looking. Add your last name or initial.' };
    case 'GUEST_CONTACT_TAKEN':
      return { status: 409, code: 'guest_taken', message: `Someone else is already looking with that ${e.kind === 'email' ? 'email' : 'phone number'}.` };
    case 'GUESTS_CLOSED':
      return { status: 403, code: 'guests_closed', message: 'Guest viewing is closed right now.' };
    case 'WRONG_GUEST_KEY':
      return { status: 403, code: 'guest_key', message: 'This QR code no longer works. Scan the one at the table.' };
    case 'GUEST_NOT_SIGNED_IN':
      return { status: 404, code: 'not_found', message: 'That guest is no longer signed in' };
    default:
      return assertNever(e);
  }
}
