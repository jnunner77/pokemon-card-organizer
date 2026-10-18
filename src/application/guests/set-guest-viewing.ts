import { ok } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';
import { endSession } from './state.ts';

/** Turn guest viewing on or off; off signs every guest out. */
export class SetGuestViewing {
  readonly #deps: Pick<GuestDeps, 'desk' | 'clock' | 'adminLog'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'clock' | 'adminLog'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly enabled: boolean }): Promise<{ readonly enabled: boolean }> {
    const now = this.#deps.clock.now();
    const changed = await this.#deps.desk.change((state) => {
      if (state.book.settings.enabled === input.enabled) return ok(false);
      state.book.settings = { ...state.book.settings, enabled: input.enabled };
      if (!input.enabled) for (const s of [...state.sessions]) endSession(state, s, 'closed', now);
      state.bookChanged = true;
      return ok(true);
    });
    if (changed.ok && changed.value) this.#deps.adminLog.info(`${input.actor} turned guest viewing ${input.enabled ? 'on' : 'off'}`, { by: input.actor });
    return { enabled: input.enabled };
  }
}
