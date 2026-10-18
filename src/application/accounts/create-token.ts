import { addToken, findPerson } from '#domain/accounts/account-book.ts';
import { readTokenName, TOKEN_PREFIX, tokenExpiry, type TokenScope } from '#domain/accounts/api-token.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';

export interface CreateTokenInput {
  readonly actor: string;
  readonly name: string;
  readonly userId: string;
  readonly scope: TokenScope;
  readonly expiresInDays: number;
}

/** A new API token acting as someone. Its secret is returned once and never kept. */
export class CreateToken {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: CreateTokenInput): Promise<Result<{ readonly token: string; readonly id: string }, AccountError>> {
    const d = this.#deps;
    const name = readTokenName(input.name);
    if (!name.ok) return name;
    const now = d.clock.now();
    const expiresAt = tokenExpiry(input.expiresInDays, now);
    if (!expiresAt.ok) return expiresAt;
    const secret = d.secrets.apiToken(TOKEN_PREFIX);
    const created = await d.accounts.change((draft) => {
      const person = findPerson(draft, input.userId);
      if (!person.ok) return person;
      if (!person.value.active) return err<AccountError>({ code: 'PERSON_INACTIVE', username: person.value.username });
      const token = addToken(draft, { id: d.secrets.id(), name: name.value, userId: person.value.id, scope: input.scope, prefix: secret.slice(0, 12), hash: d.secrets.digest(secret), createdAt: now.toISOString(), createdBy: input.actor, expiresAt: expiresAt.value, lastUsedAt: null });
      return ok({ token, username: person.value.username });
    });
    if (!created.ok) return created;
    const { token, username } = created.value;
    d.adminLog.info(`${input.actor} created API token "${token.name}" for ${username} (${token.scope})`, { by: input.actor, user: username, scope: token.scope, expiresAt: token.expiresAt });
    return ok({ token: secret, id: token.id });
  }
}
