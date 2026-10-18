import type { IncomingMessage } from 'node:http';

/** Where a request came from, as the request pipeline sees it (behind a trusted proxy, the client's own). */
export interface ClientInfo {
  readonly ip: string;
  /** Over HTTPS: cookies are then marked Secure. */
  readonly secure: boolean;
}

export type ClientResolver = (req: IncomingMessage) => ClientInfo;

/** The connection itself, for when nothing in front of the routes says otherwise. */
export const directClient: ClientResolver = (req) => ({ ip: req.socket.remoteAddress ?? '', secure: 'encrypted' in req.socket && req.socket.encrypted === true });
