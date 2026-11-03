import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/copies.js is a plain browser script; load it the way the page does.
type Card = { id?: string; name?: string; number?: string; grader?: string; grade?: string; status?: string; placeholder?: boolean; watchlist?: boolean };
type Deps = { same: (a: Card, b: Card) => boolean; gradeLabel: (g?: string, n?: string) => string; held: (c: Card) => boolean; owned: (c: Card) => boolean };
const sandbox = { window: {} as { BinderCopies: { sameCopy: (d: Deps) => (a: Card, b: Card) => boolean; note: (n: number) => string } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/copies.js'), 'utf8'), sandbox);
const { sameCopy, note } = sandbox.window.BinderCopies;

const held = (c: Card) => !['sold', 'traded'].includes(c.status ?? '');
const deps: Deps = {
  same: (a, b) => a.name === b.name && a.number === b.number,
  gradeLabel: (g, n) => (g && g !== 'Raw' ? `${g} ${n}` : ''),
  held,
  owned: (c) => held(c) && !c.placeholder && c.watchlist !== true,
};
const same = sameCopy(deps);
const pika: Card = { name: 'Pikachu', number: '7/15', status: 'binder' };

describe('copies of one card', () => {
  it('are the same printing, grade and state', () => {
    expect(same(pika, { ...pika })).toBe(true);
    expect(same(pika, { ...pika, number: '8/15' })).toBe(false);
  });
  it('keeps grades apart', () => {
    expect(same(pika, { ...pika, grader: 'PSA', grade: '10' })).toBe(false);
    expect(same({ ...pika, grader: 'PSA', grade: '10' }, { ...pika, grader: 'PSA', grade: '9' })).toBe(false);
    expect(same({ ...pika, grader: 'Raw' }, pika)).toBe(true);
  });
  it('keeps sold and traded copies apart from held ones', () => {
    expect(same(pika, { ...pika, status: 'sold' })).toBe(false);
    expect(same(pika, { ...pika, status: 'traded' })).toBe(false);
    expect(same({ ...pika, status: 'sold' }, { ...pika, status: 'sold' })).toBe(true);
  });
  it('keeps placeholders and watchlist entries apart from owned copies', () => {
    expect(same(pika, { ...pika, placeholder: true })).toBe(false);
    expect(same(pika, { ...pika, watchlist: true })).toBe(false);
  });
});

describe('the copies note', () => {
  it('says how many copies, and nothing for one', () => {
    expect(note(4)).toBe(' · 4 copies');
    expect(note(2)).toBe(' · 2 copies');
    expect(note(1)).toBe('');
  });
});
