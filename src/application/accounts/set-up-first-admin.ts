import { addPerson } from '#domain/accounts/account-book.ts';
import { checkNewPassword } from '#domain/accounts/password.ts';
import { readName, readPassword, readUsername } from '#domain/accounts/person.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { AccountDeps } from './deps.ts';
import type { AccountError } from './errors.ts';
import { startSession, type Where } from './sessions.ts';

export interface SetUpInput extends Where {
  readonly setupCode: string;
  readonly username: string;
  readonly name: string;
  readonly password: string;
}

/** Create the first administrator with the one-time setup code from the server log, and sign them in. */
export class SetUpFirstAdmin {
  readonly #deps: AccountDeps;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
  }

  async execute(input: SetUpInput): Promise<Result<{ readonly token: string; readonly maxAgeDays: number }, AccountError>> {
    const d = this.#deps;
    const username = readUsername(input.username);
    if (!username.ok) return username;
    const name = readName(input.name);
    if (!name.ok) return name;
    const password = readPassword(input.password);
    if (!password.ok) return password;
    const code = await d.setup.code();
    const book = await d.accounts.read();
    if (!code || book.users.length) return err({ code: 'ALREADY_SET_UP' });
    if (!d.secrets.same(input.setupCode.trim().toUpperCase(), code)) {
      d.securityLog.warn('Wrong first-run setup code', { ip: input.ip });
      return err({ code: 'WRONG_SETUP_CODE' });
    }
    const strong = checkNewPassword(input.password, username.value, book.settings.passwordMinLength);
    if (!strong.ok) return strong;
    const passwordHash = await d.hasher.hash(input.password);
    const at = d.clock.now().toISOString();
    const created = await d.accounts.change((draft) =>
      draft.users.length ? err<AccountError>({ code: 'ALREADY_SET_UP' }) : addPerson(draft, { id: d.secrets.id(), username: username.value, name: name.value, role: 'admin', active: true, passwordHash, passwordSetAt: at, mustChange: false, createdAt: at, lastSignInAt: at }),
    );
    if (!created.ok) return created;
    await d.setup.set(null);
    d.authLog.info(`Created the first administrator, ${created.value.username}`, { username: created.value.username, ip: input.ip });
    const token = await startSession(d, created.value, input);
    return ok({ token, maxAgeDays: book.settings.sessionMaxDays });
  }
}
