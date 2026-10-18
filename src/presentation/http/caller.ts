import type { IncomingMessage } from 'node:http';
import type { Caller } from '#application/access.ts';

/** Who sent a request: a signed-in person (or an API token acting as one), or nobody. */
export type CallerResolver = (req: IncomingMessage) => Caller | null;
