import { ok } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';
import { endSession } from './state.ts';

/** A guest signs out: their visit ends. */
export class SignOutGuest {
  readonly #deps: Pick<GuestDeps, 'desk' | 'secrets' | 'clock'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'secrets' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly token: string }): Promise<void> {
    const hash = this.#deps.secrets.digest(input.token);
    const now = this.#deps.clock.now();
    await this.#deps.desk.change((state) => {
      const session = state.sessions.find((s) => s.hash === hash);
      if (session) endSession(state, session, 'signout', now);
      return ok(undefined);
    });
  }
}
