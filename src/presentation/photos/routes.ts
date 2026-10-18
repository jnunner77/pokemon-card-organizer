import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Caller, requireRole, type Role } from '#application/access.ts';
import type { DeletePhoto } from '#application/photos/delete-photo.ts';
import type { OpenPhoto } from '#application/photos/open-photo.ts';
import type { UploadPhoto } from '#application/photos/upload-photo.ts';
import { MAX_PHOTO_BYTES } from '#domain/photos/photo.ts';
import { readBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { accessFailure, bodyFailure } from '../http/errors.ts';
import { sendEmpty, sendFailure, sendJson, sendNoContent } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { photoFailure } from './errors.ts';
import { sendPhoto } from './send-photo.ts';

export interface PhotoRouteDeps {
  readonly identify: CallerResolver;
  readonly uploadPhoto: Pick<UploadPhoto, 'execute'>;
  readonly deletePhoto: Pick<DeletePhoto, 'execute'>;
  readonly openPhoto: Pick<OpenPhoto, 'execute'>;
}

/** Card photos: uploads and deletions under /api, the pictures themselves at /blob/:id. */
export function photoRoutes(deps: PhotoRouteDeps): { readonly api: Router; readonly root: Router } {
  const allowed = (req: IncomingMessage, res: ServerResponse, needs: Role): Caller | null => {
    const r = requireRole(deps.identify(req), needs);
    if (r.ok) return r.value;
    sendFailure(res, accessFailure(r.error));
    return null;
  };

  const api = new Router()
    // Any type is accepted: the picture's own bytes say what it is.
    .add('POST', '/assets', async (req, res) => {
      if (!allowed(req, res, 'editor')) return;
      const body = await readBody(req, MAX_PHOTO_BYTES);
      if (!body.ok) return sendFailure(res, bodyFailure(body.error));
      const r = await deps.uploadPhoto.execute({ bytes: body.value ?? new Uint8Array() });
      if (r.ok) sendJson(res, 201, r.value);
      else sendFailure(res, photoFailure(r.error));
    })
    // A photo another card still shows is kept, whatever the page thought.
    .add('DELETE', '/assets/:id', async (req, res, p) => {
      if (!allowed(req, res, 'editor')) return;
      req.resume();
      await deps.deletePhoto.execute({ id: p['id'] ?? '' });
      sendNoContent(res);
    });

  // Photos never change once stored (a new photo gets a new id), so browsers may keep them forever.
  const root = new Router().add('GET', '/blob/:id', async (req, res, p) => {
    if (!allowed(req, res, 'viewer')) return;
    const photo = await deps.openPhoto.execute({ id: p['id'] ?? '' });
    if (!photo) return sendEmpty(res, 404);
    await sendPhoto(req, res, photo, 'private, max-age=31536000, immutable');
  });

  return { api, root };
}
