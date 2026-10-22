import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CardChange } from '#application/catalog/ports.ts';
import { StoreCardChanges } from '#infrastructure/json-store/card-changes.ts';
import { NodeScheduler } from '#infrastructure/node-scheduler.ts';
import { RandomShortIds } from '#infrastructure/random-ids.ts';
import { tempStore } from '../json-store/fixtures.ts';

describe("the store's cards as they change", () => {
  it('gives the cards there now, then each card saved or deleted and a whole ledger replaced', () => {
    const store = tempStore();
    store.set('cards', 'a', { name: 'Pikachu' });
    store.set('binders', 'b', { name: 'Trainers' });
    const changes = new StoreCardChanges(store);
    assert.deepEqual(changes.current(), [{ id: 'a', card: { name: 'Pikachu' } }]);
    const seen: CardChange[] = [];
    const stop = changes.subscribe((c) => seen.push(c));
    store.set('cards', 'c', { name: 'Mew' });
    store.set('binders', 'b', { name: 'Promos' });
    store.delete('cards', 'a');
    store.replaceAll({ binders: {}, cards: {}, settings: {} });
    stop();
    store.set('cards', 'd', { name: 'Eevee' });
    assert.deepEqual(seen, [{ kind: 'card', id: 'c', card: { name: 'Mew' } }, { kind: 'card', id: 'a', card: null }, { kind: 'replaced' }]);
  });
});

describe('waiting with Node’s timers', () => {
  it('pauses, and runs a job later unless it was cancelled', async () => {
    const scheduler = new NodeScheduler();
    const ran: string[] = [];
    scheduler.after(1, () => ran.push('kept'));
    const cancel = scheduler.after(1, () => ran.push('cancelled'));
    cancel();
    await scheduler.pause(20);
    assert.deepEqual(ran, ['kept']);
  });
});

describe('ids for what the server makes', () => {
  it('are 16 random hex characters', () => {
    const ids = new RandomShortIds();
    const [a, b] = [ids.next(), ids.next()];
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.notEqual(a, b);
  });
});
