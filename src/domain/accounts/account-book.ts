import { err, ok, type Result } from '#shared/result.ts';
import type { ApiToken, TokenError } from './api-token.ts';
import type { Person, PersonError } from './person.ts';
import type { Role } from './role.ts';
import type { SignInSettings } from './settings.ts';

// Everyone who can sign in, their API tokens and the sign-in settings: the aggregate behind
// Administration → People. Changes are made to a draft, which is saved only when they all succeed;
// the lists are never changed in place, only replaced.

export interface AccountBook {
  settings: SignInSettings;
  users: readonly Person[];
  tokens: readonly ApiToken[];
}

export type LastAdmin = { readonly code: 'LAST_ADMIN' };

export interface PersonChange {
  readonly name?: string | undefined;
  readonly role?: Role | undefined;
  readonly active?: boolean | undefined;
}

/** Active administrators who can sign in (they have a password), other than `except`. */
export const usableAdmins = (users: readonly Person[], except?: string): Person[] => users.filter((u) => u.active && u.role === 'admin' && u.passwordHash && u.id !== except);

export function findPerson(book: AccountBook, id: string): Result<Person, PersonError> {
  const person = book.users.find((u) => u.id === id);
  return person ? ok(person) : err({ code: 'PERSON_NOT_FOUND' });
}

/** Put the changed person in place of the one with the same id. */
export function replacePerson(book: AccountBook, person: Person): Person {
  book.users = book.users.map((u) => (u.id === person.id ? person : u));
  return person;
}

export function addPerson(book: AccountBook, person: Person): Result<Person, PersonError> {
  if (book.users.some((u) => u.username === person.username)) return err({ code: 'USERNAME_TAKEN', username: person.username });
  book.users = [...book.users, person];
  return ok(person);
}

/** Change a person's name, role or whether they're active; the last usable administrator stays one. */
export function changePerson(book: AccountBook, id: string, change: PersonChange): Result<Person, PersonError | LastAdmin> {
  const found = findPerson(book, id);
  if (!found.ok) return found;
  const u = found.value;
  const losesAdmin = u.role === 'admin' && ((change.role !== undefined && change.role !== 'admin') || change.active === false);
  if (losesAdmin && !usableAdmins(book.users, u.id).length) return err({ code: 'LAST_ADMIN' });
  return ok(replacePerson(book, { ...u, ...(change.name !== undefined ? { name: change.name } : {}), ...(change.role !== undefined ? { role: change.role } : {}), ...(change.active !== undefined ? { active: change.active } : {}) }));
}

/** Remove a person and their API tokens; an administrator only while another can sign in. */
export function removePerson(book: AccountBook, id: string): Result<Person, PersonError | LastAdmin> {
  const found = findPerson(book, id);
  if (!found.ok) return found;
  if (found.value.role === 'admin' && !usableAdmins(book.users, id).length) return err({ code: 'LAST_ADMIN' });
  book.users = book.users.filter((u) => u.id !== id);
  book.tokens = book.tokens.filter((t) => t.userId !== id);
  return ok(found.value);
}

export function addToken(book: AccountBook, token: ApiToken): ApiToken {
  book.tokens = [...book.tokens, token];
  return token;
}

export function removeToken(book: AccountBook, id: string): Result<ApiToken, TokenError> {
  const token = book.tokens.find((t) => t.id === id);
  if (!token) return err({ code: 'TOKEN_NOT_FOUND' });
  book.tokens = book.tokens.filter((t) => t.id !== id);
  return ok(token);
}
