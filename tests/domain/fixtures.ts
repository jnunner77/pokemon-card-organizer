import assert from 'node:assert/strict';
import { Binder, type BinderId } from '#domain/binders/binder.ts';
import { Card, type CardId } from '#domain/cards/card.ts';
import type { Result } from '#shared/result.ts';

export const AT = new Date('2026-10-18T12:00:00.000Z');

/** The value of a Result that must be ok. */
export function value<T, E>(r: Result<T, E>): T {
  assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.value;
}

export const cardFields = (over: Record<string, unknown> = {}) => ({
  name: 'Lapras',
  set: '30th Celebration',
  number: '131/128',
  status: 'binder',
  prices: [{ id: 'p1', type: 'market', amount: 21.2, currency: 'CAD', date: '2026-09-25' }],
  binderId: 'b1',
  page: 1,
  slot: 2,
  ...over,
});

export const card = (id: string, over: Record<string, unknown> = {}) => Card.reconstitute({ id: id as CardId, fields: cardFields(over) });
export const binder = (id: string, over: Record<string, unknown> = {}) => Binder.reconstitute({ id: id as BinderId, fields: { name: 'Trainers', pockets: 9, ...over } });
