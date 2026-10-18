import { isListed } from '#domain/guests/guest-card.ts';
import { GUEST_IDLE_MS, guestExpiry, type GuestVisit } from '#domain/guests/visits.ts';
import { ok } from '#shared/result.ts';
import type { GuestDeps } from './deps.ts';
import { sweep } from './state.ts';

export interface ActiveGuest {
  readonly id: string;
  readonly name: string;
  readonly contact: string;
  readonly contactKind: string;
  readonly ip: string;
  readonly agent: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}

export interface GuestOverviewReport {
  readonly enabled: boolean;
  readonly keyCreatedAt: string;
  readonly idleMinutes: number;
  /** The QR code's link, and the code itself as an SVG picture. */
  readonly url: string;
  readonly qr: string;
  /** Cards guests can see. */
  readonly listed: number;
  /** Guests looking now, most recently active first. */
  readonly active: ActiveGuest[];
  /** The guest log, newest first, with signed-in guests' last use filled in. */
  readonly log: readonly GuestVisit[];
}

/** Administration → Guests: the settings, the QR code, who is looking now and the guest log. */
export class GuestOverview {
  readonly #deps: Pick<GuestDeps, 'desk' | 'ledger' | 'qr' | 'clock'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'ledger' | 'qr' | 'clock'>) {
    this.#deps = deps;
  }

  /** `linkFor` makes the QR code's link from its key. */
  async execute(input: { readonly linkFor: (key: string) => string }): Promise<GuestOverviewReport> {
    const now = this.#deps.clock.now();
    const swept = await this.#deps.desk.change((state) => {
      sweep(state, now);
      return ok({ book: state.book, sessions: state.sessions });
    });
    const { book, sessions } = swept.ok ? swept.value : await this.#deps.desk.read();
    const url = input.linkFor(book.settings.key);
    const live = new Map(sessions.map((s) => [s.id, s]));
    return {
      enabled: book.settings.enabled,
      keyCreatedAt: book.settings.keyCreatedAt,
      idleMinutes: GUEST_IDLE_MS / 60_000,
      url,
      qr: await this.#deps.qr.svg(url),
      listed: (await this.#deps.ledger.read()).cards.filter(isListed).length,
      active: sessions
        .map((s) => ({ id: s.id, name: s.name, contact: s.contact, contactKind: s.contactKind, ip: s.ip, agent: s.agent, startedAt: new Date(s.createdAt).toISOString(), lastSeenAt: new Date(s.lastSeen).toISOString(), expiresAt: guestExpiry(s) }))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
      log: book.log.map((v) => {
        const s = live.get(v.id);
        return s ? { ...v, lastSeenAt: new Date(s.lastSeen).toISOString() } : { ...v };
      }),
    };
  }
}
