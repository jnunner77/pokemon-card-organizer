import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { CatalogDeps } from '#application/catalog/deps.ts';
import type { TcgGroup, TcgGroupContents } from '#domain/catalog/tcgplayer.ts';
import type { LedgerEvent } from '#domain/ledger/events.ts';
import { InstantScheduler, MemoryAnyCardPricing, MemoryCardChanges, MemoryCardDatabase, MemoryCardPricing, MemoryTcgplayerCatalog } from '#infrastructure/memory/catalog.ts';
import { MemoryLedger } from '#infrastructure/memory/ledger.ts';

const FIXTURES = path.join(import.meta.dirname, '../../fixtures/tcgdex');

/** Real TCGdex answers recorded for these tests (tests/fixtures/tcgdex), by what was asked. */
export function recordedTcgdex(): Map<string, unknown> {
  const answers = new Map<string, unknown>();
  for (const file of fs.readdirSync(FIXTURES)) answers.set(decodeURIComponent(file.replace(/\.json$/, '')), JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')));
  return answers;
}

export const NOW = new Date('2026-10-03T12:00:00.000Z');

export interface SetUpOptions {
  readonly answers?: ReadonlyMap<string, unknown> | ((path: string) => unknown);
  readonly tcgplayer?: { readonly groups: readonly TcgGroup[]; readonly contents: ReadonlyMap<number, TcgGroupContents> };
}

/** The card lookups' dependencies, all in memory, with what they logged and published. */
export function setUp(o: SetUpOptions = {}) {
  const ledger = new MemoryLedger();
  const database = new MemoryCardDatabase(o.answers ?? recordedTcgdex());
  const tcgplayer = o.tcgplayer ? new MemoryTcgplayerCatalog(o.tcgplayer.groups, o.tcgplayer.contents) : null;
  const pricing = new MemoryCardPricing();
  const anyCardPricing = new MemoryAnyCardPricing();
  const scheduler = new InstantScheduler();
  const changes = new MemoryCardChanges(ledger.tables.cards);
  const clock = { at: NOW };
  const logged: { info: string[]; warn: string[]; error: string[]; app: string[] } = { info: [], warn: [], error: [], app: [] };
  const published: LedgerEvent[] = [];
  let ids = 0;
  const deps: CatalogDeps = {
    database,
    tcgplayer,
    pricing,
    anyCardPricing,
    cards: ledger.cards,
    binders: ledger.binders,
    settings: ledger.settings,
    changes,
    unitOfWork: ledger.unitOfWork,
    events: { publish: async (events) => void published.push(...events) },
    clock: { now: () => clock.at },
    ids: { next: () => `id${String(++ids).padStart(4, '0')}` },
    scheduler,
    log: { info: (m) => void logged.info.push(m), warn: (m) => void logged.warn.push(m), error: (m) => void logged.error.push(m) },
    activity: { info: (m) => void logged.app.push(m), warn: (m) => void logged.app.push(m) },
    delayMs: 1,
  };
  return { ledger, database, tcgplayer, pricing, anyCardPricing, scheduler, changes, clock, logged, published, deps };
}

/** What a card is now, in the ledger. */
export const cardOf = (ledger: MemoryLedger, id: string): Record<string, unknown> => {
  const card = ledger.tables.cards.get(id);
  assert.ok(card, `no card ${id}`);
  return { ...card };
};

/** `actual` with only the parts `expected` names (lists element by element), for comparing a part of it. */
function picked(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(expected) && Array.isArray(actual)) return actual.map((a, i) => (i < expected.length ? picked(a, expected[i]) : a));
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && actual && typeof actual === 'object' && !Array.isArray(actual)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(expected)) if (k in actual) out[k] = picked((actual as Record<string, unknown>)[k], v);
    return out;
  }
  return actual;
}

/** Like toMatchObject: `actual` has everything `expected` says (and perhaps more). */
export function matches(actual: unknown, expected: unknown): void {
  assert.deepEqual(picked(actual, expected), expected);
}
