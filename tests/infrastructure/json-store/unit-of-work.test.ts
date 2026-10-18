import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Card, type CardId } from '#domain/cards/card.ts';
import { JsonCardRepository } from '#infrastructure/json-store/repositories.ts';
import { StoreUnitOfWork } from '#infrastructure/json-store/unit-of-work.ts';
import { err, ok } from '#shared/result.ts';
import { tempStore } from './fixtures.ts';

const AT = new Date('2026-10-18T12:00:00.000Z');

const setUp = () => {
  const store = tempStore();
  store.set('cards', 'c1', { name: 'Lapras', slot: 1 });
  store.set('binders', 'b1', { name: 'IR' });
  const unitOfWork = new StoreUnitOfWork(store);
  return { store, unitOfWork, cards: new JsonCardRepository(unitOfWork) };
};

describe('StoreUnitOfWork', () => {
  it('saves what the work changed as one change once it succeeds', async () => {
    const { store, unitOfWork, cards } = setUp();
    let changes = 0;
    store.subscribe(() => changes++);
    const r = await unitOfWork.run(async () => {
      const card = await cards.findById('c1' as CardId);
      assert.ok(card);
      assert.ok(card.merge({ slot: 2 }, AT).ok);
      await cards.save(card);
      // The work sees its own change before it is saved; the store doesn't yet.
      assert.equal((await cards.findById('c1' as CardId))?.fields['slot'], 2);
      assert.equal(store.get('cards', 'c1')?.['slot'], 1);
      return ok('done');
    });
    assert.deepEqual(r, { ok: true, value: 'done' });
    assert.equal(store.get('cards', 'c1')?.['slot'], 2);
    assert.equal(changes, 1);
  });

  it('saves nothing when the work returns an error or throws', async () => {
    const { store, unitOfWork, cards } = setUp();
    const version = store.version;
    const change = async () => {
      const card = await cards.findById('c1' as CardId);
      assert.ok(card?.merge({ slot: 9 }, AT).ok);
      await cards.save(card);
    };
    assert.deepEqual(await unitOfWork.run(async () => (await change(), err('nope'))), { ok: false, error: 'nope' });
    await assert.rejects(unitOfWork.run(async () => (await change(), Promise.reject(new Error('boom')))), /boom/);
    assert.equal(store.get('cards', 'c1')?.['slot'], 1);
    assert.equal(store.version, version);
  });

  it('lists documents with the work’s own changes and deletions on top', async () => {
    const { unitOfWork, cards } = setUp();
    await unitOfWork.run(async () => {
      const c1 = await cards.findById('c1' as CardId);
      assert.ok(c1);
      await cards.delete(c1);
      assert.deepEqual((await cards.all()).map((c) => c.id), []);
      return ok(undefined);
    });
  });

  it('runs the work again when the ledger changed while it ran, so nothing saved meanwhile is lost', async () => {
    const { store, unitOfWork, cards } = setUp();
    let runs = 0;
    await unitOfWork.run(async () => {
      runs++;
      const card = await cards.findById('c1' as CardId);
      assert.ok(card?.merge({ notes: 'from the page' }, AT).ok);
      await cards.save(card);
      // The daily update writes straight to the store, once, while the first attempt is running.
      if (runs === 1) store.update('cards', 'c1', { prices: [{ type: 'market', amount: 5, currency: 'CAD' }] });
      return ok(undefined);
    });
    assert.equal(runs, 2);
    assert.deepEqual(store.get('cards', 'c1'), { name: 'Lapras', slot: 1, prices: [{ type: 'market', amount: 5, currency: 'CAD' }], notes: 'from the page' });
  });

  it('runs units of work one at a time', async () => {
    const { unitOfWork } = setUp();
    const order: string[] = [];
    const slow = unitOfWork.run(async () => {
      order.push('a starts');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('a ends');
      return ok(undefined);
    });
    const quick = unitOfWork.run(async () => (order.push('b'), ok(undefined)));
    await Promise.all([slow, quick]);
    assert.deepEqual(order, ['a starts', 'a ends', 'b']);
  });

  it('refuses repositories used outside a unit of work, and nested units of work', async () => {
    const { unitOfWork, cards } = setUp();
    await assert.rejects(cards.findById('c1' as CardId), /outside a unit of work/);
    await assert.rejects(unitOfWork.run(async () => unitOfWork.run(async () => ok(undefined))), /cannot be nested/);
  });

  it('does not count a document made and deleted in the same work as a change', async () => {
    const { store, unitOfWork, cards } = setUp();
    const version = store.version;
    await unitOfWork.run(async () => {
      const made = Card.create('c9' as CardId, { name: 'Mew' }, AT);
      assert.ok(made.ok);
      await cards.save(made.value);
      await cards.delete(made.value);
      return ok(undefined);
    });
    assert.equal(store.get('cards', 'c9'), undefined);
    assert.equal(store.version, version);
  });
});
