import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/filter.js is a plain browser script; load it the way the page does.
type Filters = Partial<{ owners: string[]; set: string; rarity: string; status: string; yFrom: string; yTo: string; vMin: string; vMax: string }>;
type Card = Record<string, unknown>;
const sandbox = { window: {} as { BinderFilter: { count: (f: Filters) => number; match: (c: Card, f: Filters, value: number | null) => boolean } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/filter.js'), 'utf8'), sandbox);
const { count, match } = sandbox.window.BinderFilter;

const lapras = { name: 'Lapras', set: '30th Celebration', rarity: 'Illustration Rare', status: 'binder', released: '2026-03-14', owner: 'Megan' };
const promo = { name: 'Pikachu', setCode: 'SVP', status: 'listed', owner: '' };

describe('filtering the list', () => {
  it('shows everything with no filters', () => {
    expect(count({})).toBe(0);
    expect(match(lapras, {}, null)).toBe(true);
  });

  it('matches any of the ticked owners, with blank for not set', () => {
    expect(match(lapras, { owners: ['Megan', 'Both'] }, 1)).toBe(true);
    expect(match(lapras, { owners: ['Justin'] }, 1)).toBe(false);
    expect(match(promo, { owners: [''] }, 1)).toBe(true);
    expect(match({ ...promo, owner: undefined }, { owners: [''] }, 1)).toBe(true);
  });

  it('matches the set (or set code when there is no set name), rarity and status', () => {
    expect(match(lapras, { set: '30th Celebration', rarity: 'Illustration Rare', status: 'binder' }, 1)).toBe(true);
    expect(match(promo, { set: 'SVP' }, 1)).toBe(true);
    expect(match(promo, { status: 'binder' }, 1)).toBe(false);
    expect(match({ name: 'x' }, { status: 'binder' }, 1)).toBe(true); // blank status is In binder
  });

  it('matches a release year range, leaving out cards with no date', () => {
    expect(match(lapras, { yFrom: '2026' }, 1)).toBe(true);
    expect(match(lapras, { yFrom: '2020', yTo: '2025' }, 1)).toBe(false);
    expect(match(promo, { yTo: '2030' }, 1)).toBe(false);
  });

  it('matches a value range, leaving out cards with no value', () => {
    expect(match(lapras, { vMin: '10', vMax: '25' }, 21.2)).toBe(true);
    expect(match(lapras, { vMin: '25' }, 21.2)).toBe(false);
    expect(match(lapras, { vMax: '20' }, 21.2)).toBe(false);
    expect(match(lapras, { vMin: '0' }, null)).toBe(false);
  });

  it('needs every filter to match, and counts each one that is set', () => {
    const f = { owners: ['Megan', 'Justin'], set: '30th Celebration', yFrom: '2026', yTo: '2026', vMin: '5' };
    expect(count(f)).toBe(4);
    expect(match(lapras, f, 21.2)).toBe(true);
    expect(match(lapras, { ...f, rarity: 'Promo' }, 21.2)).toBe(false);
  });
});
