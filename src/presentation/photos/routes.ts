import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Caller, requireRole, type Role } from '#application/access.ts';
import type { DeletePhoto } from '#application/photos/delete-photo.ts';
import type { OpenPhoto } from '#application/photos/open-photo.ts';
import type { PhotoFile } from '#application/photos/ports.ts';
import type { UploadPhoto } from '#application/photos/upload-photo.ts';
import { MAX_PHOTO_BYTES } from '#domain/photos/photo.ts';
import { readBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { accessFailure, bodyFailure } from '../http/errors.ts';
import { sendEmpty, sendFailure, sendJson, sendNoContent } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { photoFailure } from './errors.ts';

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
    await sendPhoto(req, res, photo);
  });

  return { api, root };
}

/** The picture, or 304 when the browser's copy is current. */
async function sendPhoto(req: IncomingMessage, res: ServerResponse, photo: PhotoFile): Promise<void> {
  const etag = `W/"${photo.bytes.toString(16)}-${photo.modifiedAt.getTime().toString(16)}"`;
  const lastModified = photo.modifiedAt.toUTCString();
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastModified);
  const noneMatch = req.headers['if-none-match'];
  const modifiedSince = Date.parse(req.headers['if-modified-since'] ?? '');
  const fresh = noneMatch !== undefined ? noneMatch.split(',').some((t) => t.trim() === etag || t.trim() === '*') : !Number.isNaN(modifiedSince) && Math.floor(photo.modifiedAt.getTime() / 1000) * 1000 <= modifiedSince;
  if (fresh) {
    if (photo.content instanceof Readable) photo.content.destroy();
    return sendEmpty(res, 304);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', photo.type);
  res.setHeader('Content-Length', photo.bytes);
  if (req.method === 'HEAD') {
    if (photo.content instanceof Readable) photo.content.destroy();
    res.end();
    return;
  }
  try {
    await pipeline(Readable.from(photo.content), res);
  } catch (error) {
    // The browser went away mid-picture (a phone cancelling an image load): nothing went wrong here.
    // A picture that can't be read is still an error.
    if (isPrematureClose(error)) return;
    throw error;
  }
}

const isPrematureClose = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE';
