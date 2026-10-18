import type { ApiToken } from '#domain/accounts/api-token.ts';
import { isExpired } from '#domain/accounts/api-token.ts';
import { lockedUntil } from '#domain/accounts/lockout.ts';
import type { Person } from '#domain/accounts/person.ts';
import type { Session } from '#domain/accounts/session.ts';
import type { AccountDeps } from './deps.ts';

// What Administration → People shows: never a password hash or a token's secret.

export type PersonView = Omit<Person, 'passwordHash'> & {
  readonly hasPassword: boolean;
  readonly sessions: number;
  readonly lockedUntil: string | null;
};

export type TokenView = Omit<ApiToken, 'hash'> & { readonly user: string; readonly expired: boolean };

export async function viewOf(deps: Pick<AccountDeps, 'sessions' | 'failures' | 'clock'>, person: Person, sessions?: readonly Session[]): Promise<PersonView> {
  const { passwordHash, ...rest } = person;
  const all = sessions ?? (await deps.sessions.list());
  return { ...rest, hasPassword: !!passwordHash, sessions: all.filter((s) => s.userId === person.id).length, lockedUntil: lockedUntil(await deps.failures.get(person.username), deps.clock.now()) };
}

export function tokenView(token: ApiToken, people: readonly Person[], now: Date): TokenView {
  const { hash, ...rest } = token;
  return { ...rest, user: people.find((u) => u.id === token.userId)?.username ?? '?', expired: isExpired(token, now) };
}
