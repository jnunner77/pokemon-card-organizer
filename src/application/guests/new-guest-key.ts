import { ok } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';

/** A new key for the QR code: codes printed before stop working. Signed-in guests stay. */
export class NewGuestKey {
  readonly #deps: Pick<GuestDeps, 'desk' | 'secrets' | 'clock' | 'adminLog'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'secrets' | 'clock' | 'adminLog'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string }): Promise<void> {
    const key = this.#deps.secrets.guestKey();
    const at = this.#deps.clock.now().toISOString();
    await this.#deps.desk.change((state) => {
      state.book.settings = { ...state.book.settings, key, keyCreatedAt: at };
      state.bookChanged = true;
      return ok(undefined);
    });
    this.#deps.adminLog.info(`${input.actor} made a new guest QR code; older ones no longer work`, { by: input.actor });
  }
}
