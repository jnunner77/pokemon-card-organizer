import type { PhotoError } from '#domain/photos/photo.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

export function photoFailure(e: PhotoError): Failure {
  switch (e.code) {
    case 'PHOTO_EMPTY':
      return badRequest('No photo was sent');
    case 'NOT_A_PICTURE':
      return { status: 415, code: 'unsupported_type', message: "That file isn't a JPG, PNG, WebP or GIF picture" };
    default:
      return assertNever(e);
  }
}
