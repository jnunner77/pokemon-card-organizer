import type { ConditionRules, GuestDesk, GuestState, LedgerChange, LedgerChanges, QrCodes } from '#application/guests/ports.ts';
import type { GuestBook, GuestSession } from '#domain/guests/visits.ts';
import type { Result } from '#shared/result.ts';

// Guests kept in memory, for tests.

export class MemoryGuestDesk implements GuestDesk {
  #book: GuestBook;
  #sessions: readonly GuestSession[] = [];
  /** How many times the book was saved. */
  saves = 0;

  constructor(book: GuestBook) {
    this.#book = book;
  }

  async read(): Promise<{ readonly book: GuestBook; readonly sessions: readonly GuestSession[] }> {
    return { book: { ...this.#book }, sessions: this.#sessions };
  }

  async change<T, E>(work: (state: GuestState) => Result<T, E>): Promise<Result<T, E>> {
    const state: GuestState = { book: { ...this.#book }, sessions: this.#sessions, bookChanged: false };
    const result = work(state);
    if (!result.ok) return result;
    this.#sessions = state.sessions;
    if (state.bookChanged) {
      this.#book = state.book;
      this.saves++;
    }
    return result;
  }
}

/** Prices as they are: no condition adjustment. */
export class NoConditionRules implements ConditionRules {
  adjust(_card: unknown, price: Readonly<Record<string, unknown>>): number | null {
    const amount = price['amount'];
    return typeof amount === 'number' ? amount : null;
  }
}

/** A stand-in QR code that shows the text it encodes. */
export class TextQrCodes implements QrCodes {
  async svg(text: string): Promise<string> {
    return `<svg>${text}</svg>`;
  }
}

/** Ledger changes sent by hand. */
export class ManualLedgerChanges implements LedgerChanges {
  readonly #listeners = new Set<(change: LedgerChange) => void>();

  subscribe(listener: (change: LedgerChange) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  send(change: LedgerChange): void {
    for (const l of [...this.#listeners]) l(change);
  }
}
