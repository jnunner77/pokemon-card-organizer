import fs from 'node:fs';
import path from 'node:path';
import type { AccountStore } from '#application/accounts/ports.ts';
import type { AccountBook } from '#domain/accounts/account-book.ts';
import type { ApiToken } from '#domain/accounts/api-token.ts';
import type { Person } from '#domain/accounts/person.ts';
import { DEFAULT_SIGN_IN_SETTINGS, type SignInSettings } from '#domain/accounts/settings.ts';
import type { Result } from '#shared/result.ts';
import { damagedMessage, readJson } from '../json-store/damaged.ts';
import { writePrivate } from '../private-file.ts';

// People, their API tokens and the sign-in settings in <data>/auth.json, readable only by the
// server. It never reaches browsers, the ledger's copies or full backup downloads; the server's
// archives (deploy/backup.sh) do hold it, so a server restores with its accounts.

interface AuthFile {
  settings?: Partial<SignInSettings>;
  users?: Person[];
  tokens?: ApiToken[];
}

export class FileAccountStore implements AccountStore {
  readonly #file: string;
  #book: AccountBook;

  /** Throws when auth.json is damaged: the server stops rather than start with nobody and lock everyone out. */
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.#file = path.join(dataDir, 'auth.json');
    // The damaged file stays where it is, to be rescued.
    const raw = readJson<AuthFile>(
      this.#file,
      (d) => {
        throw new Error(`${damagedMessage(d, '')}The server won't start without its accounts: restore auth.json from a copy of the server's data, or move it away to create "admin" again from BINDER_PASSWORD (everyone else then needs adding again).`);
      },
      { keep: true },
    );
    this.#book = { settings: { ...DEFAULT_SIGN_IN_SETTINGS, ...raw?.settings }, users: raw?.users ?? [], tokens: raw?.tokens ?? [] };
  }

  async read(): Promise<AccountBook> {
    return { ...this.#book };
  }

  async change<T, E>(work: (draft: AccountBook) => Result<T, E>): Promise<Result<T, E>> {
    const draft = { ...this.#book };
    const result = work(draft);
    if (result.ok) {
      writePrivate(this.#file, JSON.stringify(draft, null, 2));
      this.#book = draft;
    }
    return result;
  }
}
