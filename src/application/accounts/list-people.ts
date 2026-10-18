import type { SignInSettings } from '#domain/accounts/settings.ts';
import type { AccountDeps } from './deps.ts';
import { type PersonView, viewOf } from './views.ts';

/** Everyone who can sign in, and the sign-in settings. */
export class ListPeople {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<{ readonly users: PersonView[]; readonly settings: SignInSettings }> {
    const book = await this.#deps.accounts.read();
    const sessions = await this.#deps.sessions.list();
    return { users: await Promise.all(book.users.map((u) => viewOf(this.#deps, u, sessions))), settings: book.settings };
  }
}
