import { nameKey, parseContact, readContactText, readGuestName, type GuestDetailsError } from '#domain/guests/contact.ts';
import { admitGuest, type GuestTaken, logVisit, MAX_GUEST_AGENT } from '#domain/guests/visits.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';
import { endSession, sweep } from './state.ts';

export type GuestSignInError = GuestDetailsError | GuestTaken | { readonly code: 'GUESTS_CLOSED' } | { readonly code: 'WRONG_GUEST_KEY' };

export interface SignInGuestInput {
  readonly key: string;
  readonly name: string;
  readonly contact: string;
  readonly ip: string;
  readonly agent: string;
}

export interface GuestSignedIn {
  /** For the guest's cookie. */
  readonly token: string;
  readonly guest: { readonly id: string; readonly name: string; readonly contact: string };
}

/**
 * Sign a guest in from the QR code, while guest viewing is on. Giving the same name and contact
 * again carries on as that guest (their other device is signed out).
 */
export class SignInGuest {
  readonly #deps: GuestDeps;

  constructor(deps: GuestDeps) {
    this.#deps = deps;
  }

  async execute(input: SignInGuestInput): Promise<Result<GuestSignedIn, GuestSignInError>> {
    const d = this.#deps;
    const name = readGuestName(input.name);
    if (!name.ok) return name;
    const contactText = readContactText(input.contact);
    if (!contactText.ok) return contactText;
    const key = input.key.trim();
    const now = d.clock.now();
    const token = d.secrets.sessionToken();
    const signedIn = await d.desk.change((state): Result<{ guest: GuestSignedIn['guest']; again: boolean }, GuestSignInError> => {
      const { settings } = state.book;
      if (!settings.enabled) return err({ code: 'GUESTS_CLOSED' });
      if (!key || !d.secrets.same(key, settings.key)) return err({ code: 'WRONG_GUEST_KEY' });
      sweep(state, now);
      const contact = parseContact(contactText.value);
      if (!contact.ok) return contact;
      const admitted = admitGuest(state.sessions, nameKey(name.value), contact.value);
      if (!admitted.ok) return admitted;
      // The same guest again (another tab or device, or after closing the page): carry on as them.
      if (admitted.value) endSession(state, admitted.value, 'replaced', now);
      const at = now.getTime();
      const agent = input.agent.slice(0, MAX_GUEST_AGENT);
      const session = { id: d.secrets.id(), hash: d.secrets.digest(token), name: name.value, nameKey: nameKey(name.value), contact: contact.value.display, contactKey: contact.value.key, contactKind: contact.value.kind, ip: input.ip, agent, createdAt: at, lastSeen: at };
      state.sessions = [...state.sessions, session];
      const iso = now.toISOString();
      logVisit(state.book, { id: session.id, name: session.name, contact: session.contact, contactKind: session.contactKind, ip: input.ip, agent, startedAt: iso, lastSeenAt: iso, endedAt: null, ended: null });
      state.bookChanged = true;
      return ok({ guest: { id: session.id, name: session.name, contact: session.contact }, again: admitted.value !== null });
    });
    if (!signedIn.ok) return signedIn;
    d.authLog.info(`Guest ${name.value} signed in`, { guest: name.value, ip: input.ip, again: signedIn.value.again });
    return ok({ token, guest: signedIn.value.guest });
  }
}
