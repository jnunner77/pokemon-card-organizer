import type { IncomingMessage } from 'node:http';

/** Where a request came from, as the request pipeline sees it (behind a trusted proxy, the client's own). */
export interface ClientInfo {
  readonly ip: string;
  /** Over HTTPS: cookies are then marked Secure. */
  readonly secure: boolean;
}

export type ClientResolver = (req: IncomingMessage) => ClientInfo;
