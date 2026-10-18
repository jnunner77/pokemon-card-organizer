import type { IncomingMessage } from 'node:http';
import type { Caller } from '#application/access.ts';
import type { Identity } from '#application/accounts/identity.ts';

/** Who sent a request: a signed-in person (or an API token acting as one), or nobody. */
export type CallerResolver = (req: IncomingMessage) => Caller | null;

/** Who sent a request, in full (for the routes that show it, like /api/auth/me). */
export type IdentityResolver = (req: IncomingMessage) => Identity | null;
