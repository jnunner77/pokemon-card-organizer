import { type GuestCard, guestCard, isListed } from '#domain/guests/guest-card.ts';
import type { GuestDeps } from './deps.ts';

/** The cards listed for sale, as guests see them. */
export class ListGuestCards {
  readonly #deps: Pick<GuestDeps, 'ledger' | 'condition' | 'secrets'>;

  constructor(deps: Pick<GuestDeps, 'ledger' | 'condition' | 'secrets'>) {
    this.#deps = deps;
  }

  async execute(): Promise<GuestCard[]> {
    const ledger = await this.#deps.ledger.read();
    const rate = Number(ledger.settings.find((s) => s.id === 'main')?.['usdToCad']) || 1;
    const adjust = (card: Parameters<typeof guestCard>[0], price: Readonly<Record<string, unknown>>) => this.#deps.condition.adjust(card, price);
    const version = (image: string) => this.#deps.secrets.digest(image).slice(0, 12);
    return ledger.cards.filter(isListed).map((c) => guestCard(c, rate, adjust, version));
  }
}
