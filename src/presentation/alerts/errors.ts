import type { AlertsNotSetUp, AppPasswordNeeded, MailFailedError, MailRefusedError } from '#application/alerts/errors.ts';
import type { InvalidSetting } from '#domain/admin/settings.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

export function alertFailure(e: InvalidSetting | AppPasswordNeeded | AlertsNotSetUp | MailRefusedError | MailFailedError): Failure {
  switch (e.code) {
    case 'INVALID_SETTING':
      return badRequest(e.message);
    case 'APP_PASSWORD_NEEDED':
      return badRequest('Add the Gmail app password (16 letters, from Google Account → Security → 2-Step Verification → App passwords).');
    case 'ALERTS_NOT_SET_UP':
      return badRequest("Alert emails aren't set up yet: save a Gmail address and app password first.");
    case 'MAIL_REFUSED':
      return badRequest(`Gmail didn't accept that address and app password (${e.message}). Check the address, and make a new app password if it still fails.`);
    case 'MAIL_FAILED':
      return { status: 502, code: 'upstream_error', message: `Couldn't send the email through Gmail: ${e.message}. Try again.` };
    default:
      return assertNever(e);
  }
}
