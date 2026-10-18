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
}

export function sendFailure(res: ServerResponse, f: Failure): void {
  sendJson(res, f.status, { error: f.message, code: f.code });
}

export function sendNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.end();
}
