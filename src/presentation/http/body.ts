import type { IncomingMessage } from 'node:http';
import type { Transform } from 'node:stream';
import zlib from 'node:zlib';
import { err, ok, type Result } from '#shared/result.ts';

export type BodyError = { readonly code: 'MALFORMED_JSON' } | { readonly code: 'BODY_TOO_LARGE' } | { readonly code: 'UNSUPPORTED_ENCODING'; readonly encoding: string };

/** Largest JSON body the ledger's routes accept (after decompressing it). */
export const JSON_LIMIT_BYTES = 1024 * 1024;

/** JSON's own whitespace, then the start of an object or a list. */
const OBJECT_OR_LIST = /^[\x20\x09\x0a\x0d]*[[{]/;

/** Undoes the request's Content-Encoding: nothing to undo, a decoder, or null when it's one we can't read. */
function decoderFor(encoding: string): Transform | undefined | null {
  switch (encoding) {
    case '':
    case 'identity':
      return undefined;
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

/**
 * Read a JSON request body. Requests that aren't `application/json`, or that announce no body at
 * all (neither Content-Length nor Transfer-Encoding), have no body (`undefined`); an announced but
 * empty JSON body is `{}`. Bodies compressed with gzip, deflate or Brotli are decompressed first,
 * and the limit applies to what they decompress to. Only objects and lists are accepted at the top
 * level; anything else, whitespace alone included, is malformed.
 */
export async function readJsonBody(req: IncomingMessage, limit = JSON_LIMIT_BYTES): Promise<Result<unknown, BodyError>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  const announced = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
  if (type !== 'application/json' || !announced) {
    req.resume(); // drain whatever was sent so the connection can be reused
    return ok(undefined);
  }
  const encoding = (req.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder = decoderFor(encoding);
  if (decoder === null) {
    req.resume();
    return err({ code: 'UNSUPPORTED_ENCODING', encoding });
  }
  // The declared length is only the decompressed size when nothing is compressed.
  const declared = Number(req.headers['content-length']);
  if (!decoder && Number.isFinite(declared) && declared > limit) {
    req.resume();
    return err({ code: 'BODY_TOO_LARGE' });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of decoder ? req.pipe(decoder) : req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) {
        decoder?.destroy();
        req.resume();
        return err({ code: 'BODY_TOO_LARGE' });
      }
      chunks.push(buffer);
    }
  } catch {
    // Compressed data that doesn't decompress.
    req.resume();
    return err({ code: 'MALFORMED_JSON' });
  }
  if (size === 0) return ok({});
  const text = Buffer.concat(chunks).toString('utf8');
  if (!OBJECT_OR_LIST.test(text)) return err({ code: 'MALFORMED_JSON' });
  try {
    return ok(JSON.parse(text));
  } catch {
    return err({ code: 'MALFORMED_JSON' });
  }
}
