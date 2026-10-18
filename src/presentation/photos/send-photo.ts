import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PhotoFile } from '#application/photos/ports.ts';
import { sendEmpty } from '../http/respond.ts';

/** The picture, or 304 when the browser's copy is current. */
export async function sendPhoto(req: IncomingMessage, res: ServerResponse, photo: PhotoFile, cacheControl: string): Promise<void> {
  const etag = `W/"${photo.bytes.toString(16)}-${photo.modifiedAt.getTime().toString(16)}"`;
  const lastModified = photo.modifiedAt.toUTCString();
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastModified);
  const noneMatch = req.headers['if-none-match'];
  const modifiedSince = Date.parse(req.headers['if-modified-since'] ?? '');
  // If-None-Match compares weakly: W/"x" and "x" are the same version.
  const weak = (tag: string) => tag.trim().replace(/^W\//, '');
  const fresh = noneMatch !== undefined ? noneMatch.split(',').some((t) => t.trim() === '*' || weak(t) === weak(etag)) : !Number.isNaN(modifiedSince) && Math.floor(photo.modifiedAt.getTime() / 1000) * 1000 <= modifiedSince;
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
