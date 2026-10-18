import { ok } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';
import { sweep } from './state.ts';

/** End the visits of guests who haven't used the page for 15 minutes (run every minute). */
export class SweepGuests {
  readonly #deps: Pick<GuestDeps, 'desk' | 'clock'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(): Promise<void> {
    const now = this.#deps.clock.now();
    await this.#deps.desk.change((state) => {
      sweep(state, now);
      return ok(undefined);
    });
  }
}
