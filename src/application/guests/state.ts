import { endVisit, type GuestSession, isGuestLive, type VisitEnd } from '#domain/guests/visits.ts';
import type { GuestState } from './ports.ts';

// Ending guests' sessions, for the use cases that change who is looking.

/** End a session: it's dropped and its visit in the log says how it ended. */
export function endSession(state: GuestState, session: GuestSession, how: VisitEnd, now: Date): void {
  state.sessions = state.sessions.filter((s) => s.id !== session.id);
  endVisit(state.book, session, how, now);
  state.bookChanged = true;
}

/** End the sessions unused for 15 minutes. */
export function sweep(state: GuestState, now: Date): void {
  for (const s of state.sessions.filter((x) => !isGuestLive(x, now))) endSession(state, s, 'timeout', now);
}

/** A signed-in guest as their page sees them. */
export interface SignedInGuest {
  readonly id: string;
  readonly name: string;
  readonly contact: string;
  /** When the visit ends if they don't use the page again. */
  readonly expiresAt: string;
}
