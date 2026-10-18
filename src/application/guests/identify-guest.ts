import { guestExpiry, isGuestLive } from '#domain/guests/visits.ts';
import { ok } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';
import { endSession, type SignedInGuest } from './state.ts';

/**
 * The guest behind a cookie, if their visit hasn't ended. `touch` counts the request as use (the
 * page's background checks and live updates don't).
 */
export class IdentifyGuest {
  readonly #deps: Pick<GuestDeps, 'desk' | 'secrets' | 'clock'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'secrets' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly token: string | undefined; readonly touch: boolean }): Promise<SignedInGuest | null> {
    if (!input.token) return null;
    const hash = this.#deps.secrets.digest(input.token);
    const now = this.#deps.clock.now();
    const found = await this.#deps.desk.change((state) => {
      const session = state.sessions.find((s) => s.hash === hash);
      if (!session) return ok(null);
      if (!isGuestLive(session, now)) {
        endSession(state, session, 'timeout', now);
        return ok(null);
      }
      const current = input.touch ? { ...session, lastSeen: now.getTime() } : session;
      if (input.touch) state.sessions = state.sessions.map((s) => (s.id === session.id ? current : s));
      return ok({ id: current.id, name: current.name, contact: current.contact, expiresAt: guestExpiry(current) });
    });
    return found.ok ? found.value : null;
  }
}
