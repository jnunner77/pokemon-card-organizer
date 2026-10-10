import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/duplicate.js is a plain browser script; load it the way the page does.
type Card = { id: string; binderId: string | null; page: number | null; slot: number | null };
type Dup = {
  MAX: number;
  most: (cards: number) => number;
  count: (value: unknown, cards: number) => number | null;
  plan: (sources: Card[], times: number, binder: (id: string) => { pockets: number | null } | null, cardAt: (b: string, p: number, s: number) => unknown, lastPage: (b: string) => number) => Card[];
};
const sandbox = { window: {} as { BinderDuplicate: Dup } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/duplicate.js'), 'utf8'), sandbox);
const { MAX, most, count, plan } = sandbox.window.BinderDuplicate;

describe('duplicating cards several times', () => {
  // Binder b1, 4 pockets a page: page 1 holds a (#1), b (#2) and d (#4); page 2 holds e (#1). Case c1 has no pockets.
  const cards: Card[] = [
    { id: 'a', binderId: 'b1', page: 1, slot: 1 },
    { id: 'b', binderId: 'b1', page: 1, slot: 2 },
    { id: 'd', binderId: 'b1', page: 1, slot: 4 },
    { id: 'e', binderId: 'b1', page: 2, slot: 1 },
    { id: 'x', binderId: 'c1', page: null, slot: null },
    { id: 'loose', binderId: null, page: null, slot: null },
  ];
  const binder = (id: string) => (id === 'b1' ? { pockets: 4 } : id === 'c1' ? { pockets: null } : null);
  const cardAt = (b: string, p: number, s: number) => cards.find((c) => c.binderId === b && c.page === p && c.slot === s);
  const lastPage = (b: string) => Math.max(1, ...cards.filter((c) => c.binderId === b).map((c) => c.page ?? 1));
  const go = (ids: string[], times: number) => plan(ids.map((id) => cards.find((c) => c.id === id)!), times, binder, cardAt, lastPage);
  const where = (list: Card[]) => list.map((c) => `${c.id}@${c.page}.${c.slot}`);

  it('puts each copy in the next empty pocket after its card, skipping full ones and going on to new pages', () => {
    expect(where(go(['b'], 1))).toEqual(['b@1.3']); // as one Duplicate always has
    expect(where(go(['b'], 4))).toEqual(['b@1.3', 'b@2.2', 'b@2.3', 'b@2.4']);
    expect(where(go(['e'], 5))).toEqual(['e@2.2', 'e@2.3', 'e@2.4', 'e@3.1', 'e@3.2']);
  });

  it("keeps each card's copies together, in order, without two copies in one pocket", () => {
    const list = go(['a', 'b'], 2);
    expect(where(list)).toEqual(['a@1.3', 'a@2.2', 'b@2.3', 'b@2.4']);
    expect(new Set(where(list).map((w) => w.split('@')[1])).size).toBe(4);
  });

  it('puts copies of a card in a display case in the case, and of a loose card nowhere', () => {
    expect(go(['x'], 3)).toEqual([0, 1, 2].map(() => ({ id: 'x', binderId: 'c1', page: null, slot: null })));
    expect(go(['loose'], 2)).toEqual([0, 1].map(() => ({ id: 'loose', binderId: null, page: null, slot: null })));
  });

  it('reads how many copies, up to 50 in all (one of each selected card always allowed)', () => {
    expect(MAX).toBe(50);
    expect([count('3', 1), count(' 50 ', 1), count('1', 1)]).toEqual([3, 50, 1]);
    expect([count('51', 1), count('0', 1), count('2.5', 1), count('-1', 1), count('', 1), count('three', 1), count(null, 1)]).toEqual([null, null, null, null, null, null, null]);
    expect([most(1), most(2), most(3), most(50), most(80)]).toEqual([50, 25, 16, 1, 1]);
    expect([count('16', 3), count('17', 3), count('1', 80), count('2', 80)]).toEqual([16, null, 1, null]);
  });
});
