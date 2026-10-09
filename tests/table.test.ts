import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/table.js is a plain browser script; load it the way the page does.
type Card = Record<string, unknown> & { id?: string };
type Col = { k: string; h: string; edit?: string; optional?: boolean };
type Choice = { v: string; label: string; n: number };
type Table = {
  COLUMNS: Col[];
  BY: Record<string, Col>;
  visible: (pref?: Record<string, boolean>) => Col[];
  raw: (c: Card, col: Col, ctx: unknown) => unknown;
  label: (col: Col, v: unknown, ctx: unknown) => string;
  choices: (cards: Card[], col: Col, ctx: unknown) => Choice[];
  matches: (c: Card, f: Record<string, string>, ctx: unknown) => boolean;
  count: (f: Record<string, string>) => number;
  sort: (cards: Card[], s: { k: string; d: number }, ctx: unknown) => Card[];
  parse: (col: Col, input: unknown, ctx: unknown) => { value?: unknown; error?: string };
  changed: (c: Card, col: Col, value: unknown) => boolean;
};
const sandbox = { window: {} as { BinderTable: Table } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/table.js'), 'utf8'), sandbox);
const T = sandbox.window.BinderTable;
const col = (k: string) => T.BY[k];

const binders: Record<string, { name: string; order: number }> = { b1: { name: 'Binder 1', order: 0 }, b2: { name: 'Binder 2', order: 1 } };
const ctx = {
  options: {
    language: ['English', 'Japanese'],
    condition: ['Near Mint', 'Lightly Played'],
    grader: ['Raw', 'PSA'],
    status: [['binder', 'In binder'], ['sold', 'Sold']],
    owner: [['', 'Not set'], ['Megan', 'Megan'], ['Justin', 'Justin'], ['Both', 'Both']],
  },
  binder: (c: Card) => binders[c.binderId as string]?.name || 'Not in a binder',
  location: (c: Card) => (binders[c.binderId as string] ? `${binders[c.binderId as string].name} · p${c.page} · #${c.slot}` : 'Loose'),
  locKey: (c: Card) => (binders[c.binderId as string] ? `${binders[c.binderId as string].order}-${String(c.page).padStart(3, '0')}-${String(c.slot).padStart(2, '0')}` : '~'),
  value: (c: Card) => (c.v as number) ?? null,
  paid: () => null,
  money: (n: number) => `$${n.toFixed(2)}`,
  picture: (c: Card) => (c.officialImageId ? 'Official image' : 'No picture'),
  match: (c: Card) => (c.pricing ? { group: 'PriceCharting', text: 'PriceCharting: Lapras' } : { group: 'Not matched', text: 'Not matched' }),
};

const lapras: Card = { id: 'a', name: 'Lapras', set: '30th Celebration', number: '31/25', owner: 'Megan', binderId: 'b1', page: 2, slot: 1, released: '2026-03-14', notes: 'Pulled at the store', v: 12 };
const pika: Card = { id: 'b', name: 'Pikachu', set: 'Promo', number: '7', binderId: 'b1', page: 1, slot: 4, placeholder: true, language: 'Japanese', v: 3.5 };
const flabebe: Card = { id: 'c', name: 'Flabébé', set: '30th Celebration', number: '100', owner: 'Justin', binderId: 'b2', page: 1, slot: 1 };
const loose: Card = { id: 'd', name: 'Eevee', owner: 'Both' };
const all = [lapras, pika, flabebe, loose];

describe('table columns', () => {
  it('shows the details and leaves picture, value, paid and the price match off until turned on', () => {
    const shown = T.visible().map(c => c.k);
    expect(shown).toContain('owner');
    expect(shown).toContain('notes');
    for (const k of ['picture', 'value', 'paid', 'match']) expect(shown).not.toContain(k);
    expect(T.visible({ value: true, owner: false }).map(c => c.k)).toEqual(expect.arrayContaining(['value']));
    expect(T.visible({ value: true, owner: false }).map(c => c.k)).not.toContain('owner');
  });

  it('always shows the card name', () => {
    expect(T.visible({ name: false }).map(c => c.k)).toContain('name');
  });

  it('reads blank dropdowns as the drawer does, and labels them', () => {
    expect(T.raw(lapras, col('language'), ctx)).toBe('English');
    expect(T.raw(pika, col('language'), ctx)).toBe('Japanese');
    expect(T.raw(pika, col('owner'), ctx)).toBe('');
    expect(T.label(col('owner'), '', ctx)).toBe('Not set');
    expect(T.label(col('status'), 'binder', ctx)).toBe('In binder');
    expect(T.label(col('placeholder'), T.raw(pika, col('placeholder'), ctx), ctx)).toBe('Yes');
    expect(T.label(col('value'), 3.5, ctx)).toBe('$3.50');
  });
});

describe('header filters', () => {
  it("lists a dropdown filter's values with counts, in the dropdown's order, blank last", () => {
    expect(T.choices(all, col('owner'), ctx)).toEqual([
      { v: 'Megan', label: 'Megan', n: 1 },
      { v: 'Justin', label: 'Justin', n: 1 },
      { v: 'Both', label: 'Both', n: 1 },
      { v: '', label: 'Not set', n: 1 },
    ]);
    expect(T.choices(all, col('set'), ctx).map(c => [c.label, c.n])).toEqual([['30th Celebration', 2], ['Promo', 1], ['(blank)', 1]]);
    expect(T.choices(all, col('released'), ctx).map(c => c.label)).toEqual(['2026', '(blank)']);
    expect(T.choices(all, col('location'), ctx).map(c => c.v)).toEqual(['Binder 1', 'Binder 2', 'Not in a binder']);
  });

  it('matches a dropdown filter exactly, with "=" alone for blank', () => {
    expect(all.filter(c => T.matches(c, { owner: '=Megan' }, ctx)).map(c => c.id)).toEqual(['a']);
    expect(all.filter(c => T.matches(c, { owner: '=' }, ctx)).map(c => c.id)).toEqual(['b']);
    expect(all.filter(c => T.matches(c, { location: '=Binder 1' }, ctx)).map(c => c.id)).toEqual(['a', 'b']);
    expect(all.filter(c => T.matches(c, { placeholder: '=Yes' }, ctx)).map(c => c.id)).toEqual(['b']);
    expect(all.filter(c => T.matches(c, { language: '=English' }, ctx)).map(c => c.id)).toEqual(['a', 'c', 'd']);
  });

  it('matches text filters anywhere in the cell, ignoring case and accents', () => {
    expect(all.filter(c => T.matches(c, { name: 'flabebe' }, ctx)).map(c => c.id)).toEqual(['c']);
    expect(all.filter(c => T.matches(c, { notes: 'STORE' }, ctx)).map(c => c.id)).toEqual(['a']);
    expect(all.filter(c => T.matches(c, { notes: '(blank)' }, ctx)).map(c => c.id)).toEqual(['b', 'c', 'd']);
    expect(all.filter(c => T.matches(c, { notes: '(not blank)' }, ctx)).map(c => c.id)).toEqual(['a']);
  });

  it('compares numbers in number filters', () => {
    expect(all.filter(c => T.matches(c, { value: '>10' }, ctx)).map(c => c.id)).toEqual(['a']);
    expect(all.filter(c => T.matches(c, { value: '<= 3.50' }, ctx)).map(c => c.id)).toEqual(['b']);
    expect(all.filter(c => T.matches(c, { value: '1-20' }, ctx)).map(c => c.id)).toEqual(['a', 'b']);
    expect(all.filter(c => T.matches(c, { value: '(blank)' }, ctx)).map(c => c.id)).toEqual(['c', 'd']);
  });

  it('combines filters, and counts only the ones set', () => {
    const f = { set: '=30th Celebration', owner: '=Justin', name: '' };
    expect(T.count(f)).toBe(2);
    expect(T.count({ nope: 'x' })).toBe(0);
    expect(all.filter(c => T.matches(c, f, ctx)).map(c => c.id)).toEqual(['c']);
  });
});

describe('sorting', () => {
  it('sorts by location by default: binder, page, pocket, loose last', () => {
    expect(T.sort(all, { k: '', d: 1 }, ctx).map(c => c.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('sorts by a column either way, with blanks last both ways', () => {
    expect(T.sort(all, { k: 'set', d: 1 }, ctx).map(c => c.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(T.sort(all, { k: 'set', d: -1 }, ctx).map(c => c.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(T.sort(all, { k: 'number', d: 1 }, ctx).map(c => c.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(T.sort(all, { k: 'value', d: -1 }, ctx).map(c => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('editing a cell', () => {
  it('trims text, and refuses a blank name or one too long', () => {
    expect(T.parse(col('notes'), '  centering is off ', ctx)).toEqual({ value: 'centering is off' });
    expect(T.parse(col('name'), '  ', ctx).error).toMatch(/name/);
    expect(T.parse(col('number'), 'x'.repeat(41), ctx).error).toMatch(/40/);
  });

  it("takes only a dropdown's own choices", () => {
    expect(T.parse(col('owner'), 'Justin', ctx)).toEqual({ value: 'Justin' });
    expect(T.parse(col('owner'), '', ctx)).toEqual({ value: '' });
    expect(T.parse(col('owner'), 'Ash', ctx).error).toBeTruthy();
    expect(T.parse(col('placeholder'), true, ctx)).toEqual({ value: true });
  });

  it("doesn't edit what the page works out", () => {
    expect(T.parse(col('location'), 'Binder 2', ctx).error).toBeTruthy();
    expect(T.parse(col('value'), '5', ctx).error).toBeTruthy();
  });

  it('knows when a value is the same as the card has', () => {
    expect(T.changed(lapras, col('owner'), 'Megan')).toBe(false);
    expect(T.changed(lapras, col('owner'), 'Both')).toBe(true);
    expect(T.changed(lapras, col('language'), 'English')).toBe(false);
    expect(T.changed(lapras, col('variant'), '')).toBe(false);
    expect(T.changed(pika, col('placeholder'), true)).toBe(false);
    expect(T.changed(lapras, col('placeholder'), false)).toBe(false);
  });
});
