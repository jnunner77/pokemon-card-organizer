import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(json));
  res.end(json);
}

/** The API's error answer: what went wrong in words, and a code for the page. */
export interface Failure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Seconds before trying again is worth it (a lock or a rate limit), sent as Retry-After. */
  readonly retryAfter?: number;
}

export function sendFailure(res: ServerResponse, f: Failure): void {
  if (f.retryAfter) res.setHeader('Retry-After', String(f.retryAfter));
  sendJson(res, f.status, { error: f.message, code: f.code });
}

export function sendNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.end();
}

/** A download: the browser saves it under this name. */
export const attachment = (filename: string): string => `attachment; filename="${filename.replace(/["\\\r\n]/g, '')}"`;

/** Text with its type, as a download when a filename is given. */
export function sendText(res: ServerResponse, type: string, text: string, filename?: string): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(text));
  if (filename) res.setHeader('Content-Disposition', attachment(filename));
  res.end(text);
}
