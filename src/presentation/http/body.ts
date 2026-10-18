import type { IncomingMessage } from 'node:http';
import { err, ok, type Result } from '#shared/result.ts';

export type BodyError = { readonly code: 'MALFORMED_JSON' } | { readonly code: 'BODY_TOO_LARGE' };

/** Largest JSON body the ledger's routes accept. */
export const JSON_LIMIT_BYTES = 1024 * 1024;

/**
 * Read a JSON request body. Requests that aren't `application/json` have no body (`undefined`);
 * an empty JSON body is `{}`. Only objects and lists are accepted at the top level.
 */
export async function readJsonBody(req: IncomingMessage, limit = JSON_LIMIT_BYTES): Promise<Result<unknown, BodyError>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    req.resume(); // drain whatever was sent so the connection can be reused
    return ok(undefined);
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return err({ code: 'BODY_TOO_LARGE' });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) {
      req.resume();
      return err({ code: 'BODY_TOO_LARGE' });
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return ok({});
  if (!/^\s*[[{]/.test(text)) return err({ code: 'MALFORMED_JSON' });
  try {
    return ok(JSON.parse(text));
  } catch {
    return err({ code: 'MALFORMED_JSON' });
  }
}
