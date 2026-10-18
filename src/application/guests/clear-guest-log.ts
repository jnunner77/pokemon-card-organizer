import { clearLog } from '#domain/guests/visits.ts';
import { ok } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';
import { sweep } from './state.ts';

/** Empty the guest log, keeping the visits of guests looking now. */
export class ClearGuestLog {
  readonly #deps: Pick<GuestDeps, 'desk' | 'clock' | 'adminLog'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'clock' | 'adminLog'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string }): Promise<{ readonly removed: number }> {
    const now = this.#deps.clock.now();
    const cleared = await this.#deps.desk.change((state) => {
      // Guests whose visit timed out since the last sweep aren't looking any more: their visits go too.
      sweep(state, now);
      const removed = clearLog(state.book, new Set(state.sessions.map((s) => s.id)));
      state.bookChanged = true;
      return ok(removed);
    });
    const n = cleared.ok ? cleared.value : 0;
    this.#deps.adminLog.info(`${input.actor} cleared the guest log (${n} visit${n === 1 ? '' : 's'})`, { by: input.actor, removed: n });
    return { removed: n };
  }
}
