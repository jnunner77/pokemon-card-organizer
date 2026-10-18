import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/expr.js is a plain browser script loaded after table.js; load them the way the page does.
type Card = Record<string, unknown> & { id?: string };
type Parsed = { ast?: unknown; error?: string; at?: number; end?: number };
type Item = { label: string; insert: string; hint: string };
type Expr = {
  parse: (src: string) => Parsed;
  editState: (text: string, applied: string) => { dirty: boolean; error: Parsed | null; canApply: boolean };
  fromSaved: (x: unknown) => { text: string; applied: string; on: boolean; open: boolean };
  test: (ast: unknown, c: Card, ctx: unknown) => boolean;
  quote: (v: string) => string;
  fromFilters: (f: Record<string, unknown>) => string;
  suggest: (src: string, caret: number | null, cards: Card[], ctx: unknown) => { from: number; to: number; kind: string; items: Item[] };
};
const sandbox: { window: { BinderExpr?: Expr; BinderTable?: { matches: (c: Card, f: Record<string, unknown>, ctx: unknown) => boolean } } } = { window: {} };
vm.createContext(sandbox);
for (const f of ['table.js', 'expr.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8'), sandbox);
const E = sandbox.window.BinderExpr as Expr;
const T = sandbox.window.BinderTable!;

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
  locKey: (c: Card) => (binders[c.binderId as string] ? `${binders[c.binderId as string].order}-${c.page}-${c.slot}` : '~'),
  value: (c: Card) => (c.v as number) ?? null,
  paid: () => null,
  money: (n: number) => `$${n.toFixed(2)}`,
  picture: () => 'No picture',
  match: () => ({ group: 'Not matched', text: 'Not matched' }),
};

const lapras: Card = { id: 'a', name: 'Lapras', set: '30th Celebration', number: '31/25', owner: 'Megan', binderId: 'b1', page: 2, slot: 1, released: '2026-03-14', notes: 'Pulled at the store', v: 12, grader: 'PSA', grade: '9.5' };
const pika: Card = { id: 'b', name: 'Pikachu', set: 'Promo', number: '7', binderId: 'b1', page: 1, slot: 4, placeholder: true, language: 'Japanese', v: 3.5, released: '1999-01-09', status: 'sold' };
const flabebe: Card = { id: 'c', name: 'Flabébé', set: '30th Celebration', number: '100', owner: 'Justin', binderId: 'b2', page: 1, slot: 1, released: '2024-11-08', rarity: 'Full Art' };
const loose: Card = { id: 'd', name: "Farfetch'd", owner: 'Both' };
const all = [lapras, pika, flabebe, loose];

const ids = (src: string) => {
  const r = E.parse(src);
  if (r.error) throw new Error(`${src}: ${r.error}`);
  return all.filter(c => E.test(r.ast, c, ctx)).map(c => c.id);
};

describe('expressions: comparisons', () => {
  it('matches every card when blank', () => {
    expect(E.parse('   ')).toEqual({ ast: null });
    expect(ids('')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('compares with = and != against the cell, what is stored, or its group, ignoring case and accents', () => {
    expect(ids('set = "30th celebration"')).toEqual(['a', 'c']);
    expect(ids('name = flabebe')).toEqual(['c']);
    expect(ids('status = sold')).toEqual(['b']);
    expect(ids('status = "In binder"')).toEqual(['a', 'c', 'd']);
    expect(ids('owner = "Not set"')).toEqual(['b']);
    expect(ids('location = "Binder 1"')).toEqual(['a', 'b']);
    expect(ids('released = 2026')).toEqual(['a']);
    expect(ids('placeholder = yes')).toEqual(['b']);
    expect(ids('placeholder = false')).toEqual(['a', 'c', 'd']);
    expect(ids('owner != Megan')).toEqual(['b', 'c', 'd']);
    expect(ids('value = 12')).toEqual(['a']);
    expect(ids("name == 'Farfetch\\'d'")).toEqual(['d']);
  });

  it('finds part of a cell with ~ (or :) and !~', () => {
    expect(ids('notes ~ store')).toEqual(['a']);
    expect(ids('name:pika')).toEqual(['b']);
    expect(ids('location ~ "p1"')).toEqual(['b', 'c']);
    expect(ids('set !~ celebration')).toEqual(['b', 'd']);
  });

  it('orders numbers, release dates by as much as given, and text', () => {
    expect(ids('value > 10')).toEqual(['a']);
    expect(ids('value <= 3.50')).toEqual(['b']);
    expect(ids('value >= $3.5')).toEqual(['a', 'b']);
    expect(ids('grade >= 9')).toEqual(['a']);
    expect(ids('number < 50')).toEqual(['a', 'b']);
    expect(ids('released >= 2024')).toEqual(['a', 'c']);
    expect(ids('released <= 2024')).toEqual(['b', 'c']);
    expect(ids('released < 2024-12')).toEqual(['b', 'c']);
    expect(ids('name < M')).toEqual(['a', 'c', 'd']);
  });

  it('takes lists with in and not in, and checks blanks with is blank', () => {
    expect(ids('owner in (Megan, Both)')).toEqual(['a', 'd']);
    expect(ids('owner not in (Megan, Both)')).toEqual(['b', 'c']);
    expect(ids('set in ("Promo", "")')).toEqual(['b', 'd']);
    expect(ids('notes is blank')).toEqual(['b', 'c', 'd']);
    expect(ids('released is not blank')).toEqual(['a', 'b', 'c']);
    expect(ids('owner is empty')).toEqual(['b']);
  });

  it('knows columns by key, heading or a few other words', () => {
    expect(ids('setcode is blank')).toEqual(['a', 'b', 'c', 'd']);
    expect(ids('Illustrator is blank')).toEqual(['a', 'b', 'c', 'd']);
    expect(ids('graded = psa')).toEqual(['a']);
    expect(ids('year >= 2024')).toEqual(['a', 'c']);
    expect(ids('price > 10')).toEqual(['a']);
  });

  it('searches the text columns for a word on its own', () => {
    expect(ids('pulled')).toEqual(['a']);
    expect(ids('"full art"')).toEqual(['c']);
    expect(ids('Megan')).toEqual(['a']);
    expect(ids('31/25')).toEqual(['a']);
  });
});

describe('expressions: and, or, not, brackets', () => {
  it('joins with and (or a space), or, not and !, and binds and before or', () => {
    expect(ids('set = "30th Celebration" and owner = Justin')).toEqual(['c']);
    expect(ids('set = "30th Celebration" owner = Justin')).toEqual(['c']);
    expect(ids('owner = Justin or owner = Both')).toEqual(['c', 'd']);
    expect(ids('owner = Megan or owner = Justin and value > 100')).toEqual(['a']);
    expect(ids('(owner = Megan or owner = Justin) and value > 100')).toEqual([]);
    expect(ids('not owner = Megan')).toEqual(['b', 'c', 'd']);
    expect(ids('!(owner in (Megan, Both))')).toEqual(['b', 'c']);
    expect(ids('not not pika')).toEqual(['b']);
    expect(ids('owner = Megan || owner = Both && notes is blank')).toEqual(['a', 'd']);
    expect(ids('set = "30th Celebration" and not owner in (Megan, Both) and (value > 10 or grader != Raw)')).toEqual([]);
    expect(ids('set = "30th Celebration" and not owner in (Megan, Both) and (value > 10 or grader = Raw)')).toEqual(['c']);
  });

  it('reads keywords in any case', () => {
    expect(ids('OWNER = megan OR Owner = both')).toEqual(['a', 'd']);
    expect(ids('NOT notes IS NOT BLANK')).toEqual(['b', 'c', 'd']);
  });
});

describe('expressions: mistakes', () => {
  const err = (src: string) => E.parse(src);
  it('says what is wrong and where', () => {
    expect(err('owner =')).toMatchObject({ error: expect.stringMatching(/Put a value after =/), at: 6, end: 7 });
    expect(err('colour = red')).toMatchObject({ error: expect.stringMatching(/no column called colour/), at: 0, end: 6 });
    expect(err('(owner = Megan')).toMatchObject({ error: expect.stringMatching(/isn't closed/), at: 0 });
    expect(err('owner = Megan)')).toMatchObject({ error: expect.stringMatching(/doesn't close anything/), at: 13 });
    expect(err('name = "Lapras')).toMatchObject({ error: expect.stringMatching(/quote isn't closed/), at: 7 });
    expect(err('owner in Megan')).toMatchObject({ error: expect.stringMatching(/list in brackets/) });
    expect(err('owner in (Megan Both)')).toMatchObject({ error: expect.stringMatching(/separated by commas/) });
    expect(err('owner in ()')).toMatchObject({ error: expect.stringMatching(/Put a value/) });
    expect(err('notes is full')).toMatchObject({ error: expect.stringMatching(/is goes with blank/) });
    expect(err('owner = Megan and')).toMatchObject({ error: expect.stringMatching(/after and/) });
    expect(err('or pika')).toMatchObject({ error: expect.stringMatching(/before or/) });
    expect(err('> 10')).toMatchObject({ error: expect.stringMatching(/needs a column/) });
    expect(err('()')).toMatchObject({ error: expect.stringMatching(/nothing between/) });
    expect(err('not')).toMatchObject({ error: expect.stringMatching(/after not/) });
  });
});

describe('expressions: editing before applying', () => {
  it('can apply an edit that changed and reads cleanly', () => {
    expect(E.editState('owner = Megan', '')).toMatchObject({ dirty: true, error: null, canApply: true });
    expect(E.editState('', 'owner = Megan')).toMatchObject({ dirty: true, canApply: true }); // applying a blank one stops filtering
  });

  it("has nothing to apply when the edit is what's applied, spaces at the ends aside", () => {
    expect(E.editState('owner = Megan', 'owner = Megan')).toMatchObject({ dirty: false, canApply: false });
    expect(E.editState('  owner = Megan \n', 'owner = Megan')).toMatchObject({ dirty: false, canApply: false });
    expect(E.editState('', '')).toMatchObject({ dirty: false, canApply: false });
  });

  it('reads the saved settings, keeping an expression saved before Apply existed applied', () => {
    expect(E.fromSaved({ text: 'owner = Megan', on: true, open: true })).toEqual({ text: 'owner = Megan', applied: 'owner = Megan', on: true, open: true });
    expect(E.fromSaved({ text: 'owner = Me', applied: 'owner = Megan', on: false, open: false })).toEqual({ text: 'owner = Me', applied: 'owner = Megan', on: false, open: false });
    expect(E.fromSaved({ text: 'pika' })).toEqual({ text: 'pika', applied: 'pika', on: true, open: false });
    for (const bad of [undefined, null, 'owner = Megan', [], { text: 5 }]) expect(E.fromSaved(bad)).toEqual({ text: '', applied: '', on: true, open: false });
  });

  it("can't apply an edit with a mistake, and says where it is", () => {
    const x = E.editState('owner = Megan and', 'owner = Megan');
    expect(x).toMatchObject({ dirty: true, canApply: false, error: { error: expect.stringMatching(/after and/), at: 14 } });
  });
});

describe('expressions: from the header filters', () => {
  const same = (f: Record<string, unknown>) => {
    const src = E.fromFilters(f);
    expect(ids(src)).toEqual(all.filter(c => T.matches(c, f, ctx)).map(c => c.id));
    return src;
  };

  it('writes the header filters as an expression that picks the same cards', () => {
    expect(E.fromFilters({})).toBe('');
    expect(same({ owner: { in: ['Megan'] } })).toBe('owner = Megan');
    expect(same({ owner: { in: ['Megan', 'Both'] } })).toBe('owner in (Megan, Both)');
    expect(same({ owner: { in: ['Megan', 'Both'], not: true } })).toBe('owner not in (Megan, Both)');
    expect(same({ owner: { in: [''] } })).toBe('owner is blank');
    expect(same({ owner: { in: ['', 'Megan'] } })).toBe('(owner is blank or owner = Megan)');
    expect(same({ owner: { in: ['', 'Megan'], not: true } })).toBe('not (owner is blank or owner = Megan)');
    expect(same({ set: '=30th Celebration' })).toBe('set = "30th Celebration"');
    expect(same({ setCode: { in: ['SVP'], not: true } })).toBe('setcode != SVP');
    expect(same({ name: 'pika' })).toBe('name ~ pika');
    expect(same({ name: '!pika' })).toBe('name !~ pika');
    expect(same({ notes: '(blank)' })).toBe('notes is blank');
    expect(same({ notes: '!(blank)' })).toBe('notes is not blank');
    expect(same({ value: '>10' })).toBe('value > 10');
    expect(same({ value: '!>10' })).toBe('not value > 10');
    expect(same({ value: '!5' })).toBe('value != 5');
    expect(same({ value: '1-20' })).toBe('(value >= 1 and value <= 20)');
    expect(same({ value: '!1-20' })).toBe('not (value >= 1 and value <= 20)');
    expect(same({ owner: { in: ['Megan', 'Justin'] }, set: '=30th Celebration', name: 'a' })).toBe('owner in (Megan, Justin) and set = "30th Celebration" and name ~ a');
  });

  it('quotes values only when it has to', () => {
    expect(E.quote('SVP')).toBe('SVP');
    expect(E.quote('31/25')).toBe('31/25');
    expect(E.quote('Flabébé')).toBe('Flabébé');
    expect(E.quote('Full Art')).toBe('"Full Art"');
    expect(E.quote('and')).toBe('"and"');
    expect(E.quote('')).toBe('""');
    expect(E.quote('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe('expressions: suggestions', () => {
  const at = (src: string) => E.suggest(src, null, all, ctx);
  const labels = (src: string) => at(src).items.map(i => i.label);

  it('suggests columns to start with, narrowed by what is typed', () => {
    expect(labels('')).toEqual(expect.arrayContaining(['name', 'set', 'owner', 'not', '(']));
    expect(at('ow')).toMatchObject({ from: 0, to: 2, kind: 'field' });
    expect(labels('ow')[0]).toBe('owner');
    expect(labels('set = Promo and se').slice(0, 2)).toEqual(['set', 'setcode']);
  });

  it("suggests the operators that suit the column, then the column's values", () => {
    expect(labels('owner ')).toEqual(expect.arrayContaining(['=', '!=', 'in (', 'is blank']));
    expect(labels('owner ')).not.toContain('>');
    expect(labels('value ')).toContain('>=');
    expect(labels('value >')).toEqual(['>', '>=']);
    expect(at('owner = ')).toMatchObject({ kind: 'value' });
    expect(labels('owner = ')).toEqual(['Megan', 'Justin', 'Both']);
    expect(labels('set = ')).toEqual(['30th Celebration', 'Promo']);
    expect(at('set = ')).toMatchObject({ items: [{ insert: '"30th Celebration" ' }, { insert: 'Promo ' }] });
    expect(at('owner = Ju')).toMatchObject({ from: 8, to: 10, items: [{ label: 'Justin' }] });
    expect(labels('owner in (Megan, ')).toEqual(['Megan', 'Justin', 'Both']);
    expect(labels('owner in (Megan ')).toEqual([',', ')']);
    expect(labels('notes is ')).toEqual(['blank', 'not blank']);
  });

  it('suggests and / or after a finished comparison, and ) inside brackets', () => {
    expect(labels('owner = Megan ')).toEqual(['and', 'or']);
    expect(labels('(owner = Megan ')).toEqual(['and', 'or', ')']);
    expect(at('owner = Megan and ')).toMatchObject({ kind: 'field' });
  });

  it('suggests from the caret, not the end', () => {
    const src = 'own = Megan';
    expect(E.suggest(src, 3, all, ctx)).toMatchObject({ from: 0, to: 3, items: [{ label: 'owner' }] });
  });
});
