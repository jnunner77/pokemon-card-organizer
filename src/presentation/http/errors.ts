import type { AccessError } from '#application/access.ts';
import { assertNever } from '#shared/result.ts';
import type { BodyError } from './body.ts';
import type { Failure } from './respond.ts';

export const badRequest = (message: string): Failure => ({ status: 400, code: 'invalid_argument', message });

export function accessFailure(e: AccessError): Failure {
  switch (e.code) {
    case 'SIGN_IN_REQUIRED':
      return { status: 401, code: 'signin', message: 'Please sign in' };
    case 'NOT_ALLOWED':
      return { status: 403, code: 'forbidden', message: e.needs === 'admin' ? 'Only administrators can do this.' : 'You have view-only access.' };
    default:
      return assertNever(e);
  }
}

export function bodyFailure(e: BodyError): Failure {
  switch (e.code) {
    case 'BODY_TOO_LARGE':
      return { status: 413, code: 'too_large', message: 'That upload is too large' };
    case 'MALFORMED_JSON':
      return badRequest("The request body isn't valid JSON");
    case 'UNREADABLE_BODY':
      return badRequest("The upload couldn't be read");
    case 'UNSUPPORTED_ENCODING':
      return { status: 415, code: 'unsupported_type', message: `Unsupported content encoding "${e.encoding}"` };
    default:
      return assertNever(e);
  }
}
