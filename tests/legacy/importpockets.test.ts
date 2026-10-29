import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/importpockets.js and public/stack.js are plain browser scripts; load them the way the page does.
type Data = { name: string; number?: string };
type Row = { line: number; data: Data; errors: string[]; warns: string[]; bkey: string | null; page: number | null; slot: number | null; auto?: boolean; inCase?: boolean; replaced?: boolean; replaceId?: string; replaceName?: string; replaceOld?: unknown; home?: string };
type Existing = Map<string, { id: string; name: string; number?: string }[]>;
type Assign = (rows: Row[], existing: Existing, o: { taken: string; pocketsFor: (bkey: string) => number }, same: (a: unknown, b: unknown) => boolean) => Row[];
const sandbox = { window: {} as { BinderStack: { same: (a: unknown, b: unknown) => boolean }; BinderImportPockets: { assign: Assign } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/stack.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/importpockets.js'), 'utf8'), sandbox);
const { same } = sandbox.window.BinderStack;
const { assign } = sandbox.window.BinderImportPockets;

const pikachu = { name: 'Pikachu', number: '58/102' };
const raichu = { name: 'Raichu', number: '14/102' };
const row = (line: number, data: Data, page: number | null = 1, slot: number | null = 1, over: Partial<Row> = {}): Row => ({ line, data, errors: [], warns: [], bkey: 'id:b1', page, slot, auto: page === null, ...over });
const ledger = (...entries: [number, number, { id: string; name: string; number?: string }[]][]): Existing => new Map(entries.map(([page, slot, cards]) => [`id:b1|${page}|${slot}`, cards]));
const run = (rows: Row[], taken: string, existing: Existing = new Map()) => assign(rows, existing, { taken, pocketsFor: () => 4 }, same);
const at = (rows: Row[]) => rows.map((r) => `${r.line}@${r.page}.${r.slot}`);

describe('which pocket each CSV row goes in', () => {
  it('puts rows for the same card in the same pocket together, whatever the choice', () => {
    for (const taken of ['replace', 'next', 'error']) {
      const rows = run([row(2, pikachu), row(3, { ...pikachu, number: '058' }), row(4, pikachu)], taken);
      expect(at(rows)).toEqual(['2@1.1', '3@1.1', '4@1.1']);
      expect(rows.every((r) => !r.errors.length && !r.warns.length && !r.replaced)).toBe(true);
    }
  });

  it('lets a different card in the file replace the earlier rows (Replace)', () => {
    const rows = run([row(2, pikachu), row(3, pikachu), row(4, raichu)], 'replace');
    expect(rows.map((r) => r.replaced ?? false)).toEqual([true, true, false]);
    expect(rows[0]?.errors[0]).toBe('Replaced by row 4 (Raichu), which uses the same page and pocket later in the file.');
    expect(rows[2]?.errors).toEqual([]);
  });

  it('sends a different card to the next empty pocket (Next), or flags it (Flag)', () => {
    const next = run([row(2, pikachu), row(3, raichu), row(4, raichu), row(5, pikachu, 1, 2)], 'next');
    expect(at(next)).toEqual(['2@1.1', '3@1.3', '4@1.3', '5@1.2']);
    expect(next[1]?.warns[0]).toBe('Page 1, pocket 1 is taken by row 2 (Pikachu), so this card goes in the next empty pocket.');
    const flag = run([row(2, pikachu), row(3, raichu)], 'error');
    expect(flag[1]?.errors).toEqual(['Page 1, pocket 1 is already taken by row 2 (Pikachu).']);
    expect(flag[0]?.errors).toEqual([]);
  });

  it('replaces the ledger’s copies one by one, and adds the extra rows as copies (Replace)', () => {
    const copies = [{ id: 'a', name: 'Pikachu', number: '58/102' }, { id: 'b', name: 'Pikachu', number: '58/102' }];
    const rows = run([row(2, pikachu), row(3, pikachu), row(4, pikachu)], 'replace', ledger([1, 1, copies]));
    expect(rows.map((r) => r.replaceId)).toEqual(['a', 'b', undefined]);
    expect(rows[0]?.warns).toEqual(['Replaces Pikachu in page 1, pocket 1. Its details and price log are overwritten.']);
    expect(rows[2]?.warns).toEqual([]);
  });

  it('round trips an export: three rows for a stacked pocket replace three copies', () => {
    const copies = ['a', 'b', 'c'].map((id) => ({ id, name: 'Pikachu', number: '58/102' }));
    const rows = run([row(2, pikachu), row(3, pikachu), row(4, pikachu)], 'replace', ledger([1, 1, copies]));
    expect(rows.map((r) => r.replaceId)).toEqual(['a', 'b', 'c']);
    expect(rows.every((r) => !r.errors.length)).toBe(true);
  });

  it('replaces the first copies when fewer rows are the same card as the copies', () => {
    const copies = ['a', 'b', 'c'].map((id) => ({ id, name: 'Pikachu', number: '58/102' }));
    const rows = run([row(2, pikachu)], 'replace', ledger([1, 1, copies]));
    expect(rows[0]?.replaceId).toBe('a');
    expect(rows[0]?.errors).toEqual([]);
  });

  it('refuses a different card that is fewer than the ledger’s copies, on the last row', () => {
    const copies = ['a', 'b', 'c'].map((id) => ({ id, name: 'Pikachu', number: '58/102' }));
    const rows = run([row(2, raichu), row(3, raichu)], 'replace', ledger([1, 1, copies]));
    expect(rows[1]?.errors).toEqual(['Page 1, pocket 1 has 3 copies of Pikachu; give each one a row, or use another pocket.']);
    expect(rows[0]?.errors).toEqual(["Not imported: row 3 can't replace every copy in page 1, pocket 1."]);
    // One different card replacing one lone card is the usual replace.
    const one = run([row(2, raichu)], 'replace', ledger([1, 1, [{ id: 'a', name: 'Pikachu', number: '58/102' }]]));
    expect(one[0]?.replaceId).toBe('a');
    expect(one[0]?.errors).toEqual([]);
    // As many rows as copies is fine.
    const all = run([row(2, raichu), row(3, raichu), row(4, raichu)], 'replace', ledger([1, 1, copies]));
    expect(all.map((r) => r.replaceId)).toEqual(['a', 'b', 'c']);
  });

  it('adds rows for the same card as another copy under Next or Flag, and sends on a different card', () => {
    const copies = [{ id: 'a', name: 'Pikachu', number: '58/102' }];
    for (const taken of ['next', 'error']) {
      const rows = run([row(2, pikachu), row(3, pikachu)], taken, ledger([1, 1, copies]));
      expect(rows.every((r) => !r.errors.length && !r.replaceId)).toBe(true);
      expect(rows[0]?.warns).toEqual(['Added as another copy of Pikachu, already in page 1, pocket 1.']);
    }
    const next = run([row(2, raichu), row(3, raichu)], 'next', ledger([1, 1, copies]));
    expect(at(next)).toEqual(['2@1.2', '3@1.2']);
    expect(next[0]?.warns[0]).toBe('Page 1, pocket 1 is taken by Pikachu (already in your ledger), so this card goes in the next empty pocket.');
    const flag = run([row(2, raichu)], 'error', ledger([1, 1, copies]));
    expect(flag[0]?.errors).toEqual(['Page 1, pocket 1 is already taken by Pikachu (already in your ledger).']);
  });

  it('puts rows with no page and pocket in the next empty pockets, skipping the ledger’s and the file’s', () => {
    const rows = run([row(2, raichu, 1, 2), row(3, { name: 'Eevee' }, null, null), row(4, { name: 'Mew' }, null, null)], 'replace', ledger([1, 1, [{ id: 'a', name: 'Pikachu' }]]));
    expect(at(rows)).toEqual(['2@1.2', '3@1.3', '4@1.4']);
  });

  it('leaves rows with errors, in a case or in no binder alone', () => {
    const bad = row(2, pikachu, 1, 1, { errors: ['Name is blank.'] });
    const inCase = row(3, pikachu, null, null, { inCase: true, auto: false });
    const none = row(4, pikachu, null, null, { bkey: null, auto: false });
    const good = row(5, raichu);
    run([bad, inCase, none, good], 'replace');
    expect([bad.page, inCase.page, none.page, good.page]).toEqual([1, null, null, 1]);
    expect(good.errors).toEqual([]);
  });
});
