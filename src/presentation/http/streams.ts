import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Failure } from './respond.ts';

/**
 * The request pipeline's limit on open live-update connections: a connection to keep open (with
 * the function that releases it), or the answer to refuse it with. `key` counts it against that
 * caller (a guest) rather than their address.
 */
export type StreamGate = (req: IncomingMessage, res: ServerResponse, key: string) => { readonly release: () => void } | { readonly refused: Failure };

/** No limit. */
export const openGate: StreamGate = () => ({ release: () => {} });
