import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LedgerEvent } from '#domain/ledger/events.ts';
import { LocalEventBus } from '#infrastructure/local-event-bus.ts';

const at = new Date('2026-10-18T12:00:00.000Z');
const saved = (id: string): LedgerEvent => ({ type: 'DocumentSaved', collection: 'cards', id, occurredAt: at });

describe('LocalEventBus', () => {
  it('hands every event to every subscriber, in order', async () => {
    const bus = new LocalEventBus();
    const first: string[] = [];
    const second: string[] = [];
    bus.subscribe((e) => first.push(e.id));
    bus.subscribe((e) => second.push(e.id));
    await bus.publish([saved('a'), saved('b')]);
    assert.deepEqual([first, second], [['a', 'b'], ['a', 'b']]);
  });

  it('stops handing events to a subscriber that unsubscribed', async () => {
    const bus = new LocalEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((e) => seen.push(e.id));
    await bus.publish([saved('a')]);
    unsubscribe();
    await bus.publish([saved('b')]);
    assert.deepEqual(seen, ['a']);
  });

  it('publishing nothing, or with nobody listening, is fine', async () => {
    const bus = new LocalEventBus();
    await bus.publish([saved('a')]);
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.id));
    await bus.publish([]);
    assert.deepEqual(seen, []);
  });
});
