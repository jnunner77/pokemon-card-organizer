import { err, ok, type Result } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';
import { endSession } from './state.ts';

export type GuestNotSignedIn = { readonly code: 'GUEST_NOT_SIGNED_IN' };

/** An administrator signs a guest out. */
export class EndGuestVisit {
  readonly #deps: Pick<GuestDeps, 'desk' | 'clock' | 'adminLog'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'clock' | 'adminLog'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly id: string }): Promise<Result<void, GuestNotSignedIn>> {
    const now = this.#deps.clock.now();
    const ended = await this.#deps.desk.change((state): Result<string, GuestNotSignedIn> => {
      const session = state.sessions.find((s) => s.id === input.id);
      if (!session) return err({ code: 'GUEST_NOT_SIGNED_IN' });
      endSession(state, session, 'admin', now);
      return ok(session.name);
    });
    if (!ended.ok) return ended;
    this.#deps.adminLog.info(`${input.actor} signed out the guest ${ended.value}`, { by: input.actor, guest: ended.value });
    return ok(undefined);
  }
}
