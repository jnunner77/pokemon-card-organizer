import type { GuestSettings } from '#domain/guests/visits.ts';
import type { GuestDeps } from './deps.ts';

/** Whether guest viewing is on, and the QR code's key. */
export class ReadGuestViewing {
  readonly #deps: Pick<GuestDeps, 'desk'>;

  constructor(deps: Pick<GuestDeps, 'desk'>) {
    this.#deps = deps;
  }

  async execute(): Promise<GuestSettings> {
    return (await this.#deps.desk.read()).book.settings;
  }
}
