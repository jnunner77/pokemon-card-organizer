import type { Person } from '#domain/accounts/person.ts';
import { MAX_AGENT } from '#domain/accounts/session.ts';
import type { AccountDeps } from './deps.ts';

// Starting and ending sessions, for the use cases that sign people in and out.

export interface Where {
  readonly ip: string;
  readonly agent: string;
}

/** Sign the person in on this browser: returns the token for its cookie. */
export async function startSession(deps: Pick<AccountDeps, 'sessions' | 'secrets' | 'clock'>, person: Person, where: Where): Promise<string> {
  const token = deps.secrets.sessionToken();
  const at = deps.clock.now().getTime();
  await deps.sessions.add({ id: deps.secrets.id(), hash: deps.secrets.digest(token), userId: person.id, createdAt: at, lastSeen: at, ip: where.ip, agent: where.agent.slice(0, MAX_AGENT) });
  return token;
}

/** Sign the person out everywhere; returns how many sessions ended. */
export const endSessionsOf = (deps: Pick<AccountDeps, 'sessions'>, personId: string): Promise<number> => deps.sessions.remove((s) => s.userId === personId);
