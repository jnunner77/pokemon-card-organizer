import type { LedgerDeps } from '#application/ledger/deps.ts';
import type { LedgerEvent } from '#domain/ledger/events.ts';
import { MemoryLedger } from '#infrastructure/memory/ledger.ts';

export const NOW = new Date('2026-10-18T12:00:00.000Z');

/** The ledger use cases' dependencies, all in memory, with what they published and logged. */
export function setUp() {
  const ledger = new MemoryLedger();
  const published: LedgerEvent[] = [];
  const logged: string[] = [];
  const deps: LedgerDeps = {
    cards: ledger.cards,
    binders: ledger.binders,
    settings: ledger.settings,
    reader: ledger.reader,
    unitOfWork: ledger.unitOfWork,
    clock: { now: () => NOW },
    events: { publish: async (events) => void published.push(...events) },
    activity: { info: (message) => void logged.push(message), warn: (message) => void logged.push(message) },
  };
  return { ledger, deps, published, logged };
}

export const card = (over: Record<string, unknown> = {}) => ({ name: 'Lapras', number: '131', status: 'binder', binderId: 'b1', page: 1, slot: 1, ...over });
