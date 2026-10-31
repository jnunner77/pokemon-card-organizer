import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/keys.js is a plain browser script; load it the way the page does.
type Ev = { key?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; code?: string; repeat?: boolean };
type Keys = {
  shortcut: (e: Ev) => string | null;
  step: (filled: number[], cols: number, from: number | null, key: string) => number | null;
  range: (filled: number[], a: number, b: number) => number[];
  modLabel: (platform: string) => string;
  allowed: (k: string | null, ctx: Record<string, boolean>) => boolean;
  target: (picked: string[] | null, open: string | null) => { ids: string[]; picking: boolean } | null;
  canExtend: (st: Record<string, unknown>) => boolean;
  digit: (e: Ev) => number | null;
  holds: (e: Ev) => boolean;
  pocketPress: (st: Record<string, unknown>) => { slot: number | null; add: boolean; pending: Record<string, unknown> | null };
  pocketDue: (st: Record<string, unknown>) => number | null;
  pocketPick: (st: Record<string, unknown>) => { kb: Record<string, unknown>; start: boolean; keep: boolean };
  extend: (st: Record<string, unknown>) => { kb: Record<string, unknown>; start: boolean; slots: number[] } | null;
};
const sandbox = { window: {} as { BinderKeys: Keys } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/keys.js'), 'utf8'), sandbox);
const { shortcut, step, range, modLabel, allowed, target, canExtend, extend, digit, holds, pocketPress, pocketDue, pocketPick } = sandbox.window.BinderKeys;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('which shortcut a key press is', () => {
  it('maps Ctrl or Command with d, o, s and k', () => {
    expect(shortcut({ key: 'd', ctrlKey: true })).toBe('duplicate');
    expect(shortcut({ key: 'd', metaKey: true })).toBe('duplicate');
    expect(shortcut({ key: 'D', ctrlKey: true })).toBe('duplicate');
    expect(shortcut({ key: 'o', ctrlKey: true })).toBe('owner');
    expect(shortcut({ key: 's', metaKey: true })).toBe('status');
    expect(shortcut({ key: 'k', ctrlKey: true })).toBe('find');
    expect(shortcut({ key: 'k', metaKey: true })).toBe('find');
  });
  it('maps / to find, with or without Shift', () => {
    expect(shortcut({ key: '/' })).toBe('find');
    expect(shortcut({ key: '/', shiftKey: true })).toBe('find');
  });
  it('leaves everything else alone', () => {
    expect(shortcut({ key: 'f', ctrlKey: true })).toBeNull();
    expect(shortcut({ key: 'f', metaKey: true })).toBeNull();
    expect(shortcut({ key: 'd', ctrlKey: true, shiftKey: true })).toBeNull();
    expect(shortcut({ key: 'd', ctrlKey: true, altKey: true })).toBeNull();
    expect(shortcut({ key: 'd' })).toBeNull();
    expect(shortcut({ key: '/', ctrlKey: true })).toBeNull();
    expect(shortcut({})).toBeNull();
  });
  it('maps Shift with an arrow key to extending the selection', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) expect(shortcut({ key, shiftKey: true })).toBe('extend');
    expect(shortcut({ key: 'ArrowRight' })).toBeNull();
    expect(shortcut({ key: 'ArrowRight', shiftKey: true, ctrlKey: true })).toBeNull();
  });
});

describe('moving between filled pockets', () => {
  const f = [1, 2, 4, 5, 9];
  it('steps along and down a 3-column page', () => {
    expect(step(f, 3, 2, 'ArrowRight')).toBe(4);
    expect(step(f, 3, 4, 'ArrowLeft')).toBe(2);
    expect(step(f, 3, 2, 'ArrowDown')).toBe(5);
    expect(step(f, 3, 5, 'ArrowDown')).toBe(9);
    expect(step(f, 3, 9, 'ArrowUp')).toBe(5);
  });
  it('stops at the edges', () => {
    expect(step(f, 3, 1, 'ArrowUp')).toBeNull();
    expect(step(f, 3, 9, 'ArrowRight')).toBeNull();
  });
  it('starts from the first or last pocket when there is none yet', () => {
    expect(step(f, 3, null, 'ArrowRight')).toBe(1);
    expect(step(f, 3, null, 'ArrowLeft')).toBe(9);
    expect(step([], 3, null, 'ArrowRight')).toBeNull();
  });
  it('takes the pockets between two, whichever is first', () => {
    expect(plain(range(f, 5, 2))).toEqual([2, 4, 5]);
    expect(plain(range(f, 4, 4))).toEqual([4]);
  });
});

describe('the modifier key label', () => {
  it('is the Command sign on Apple devices and Ctrl+ elsewhere', () => {
    expect(modLabel('MacIntel')).toBe('⌘');
    expect(modLabel('iPhone')).toBe('⌘');
    expect(modLabel('Win32')).toBe('Ctrl+');
    expect(modLabel('')).toBe('Ctrl+');
  });
});

describe('up and down across rows', () => {
  it('goes to the nearest filled pocket in the next row, even to the left', () => {
    expect(step([1, 2, 3, 4], 3, 2, 'ArrowDown')).toBe(4);
    expect(step([1, 2, 3, 4], 3, 4, 'ArrowUp')).toBe(1);
    expect(step([1, 2, 6], 3, 6, 'ArrowUp')).toBe(2);
    expect(step([1, 3, 4, 6], 3, 2, 'ArrowDown')).toBe(4);
  });
  it('skips a row with nothing filled', () => {
    expect(step([2, 8], 3, 2, 'ArrowDown')).toBe(8);
    expect(step([2, 8], 3, 8, 'ArrowUp')).toBe(2);
  });
});

describe('when a shortcut may act', () => {
  const none = { lightbox: false, modal: false, typing: false, table: false, pricing: false, selling: false };
  it('is blocked by a dialog, the viewer or typing', () => {
    expect(allowed('duplicate', none)).toBe(true);
    for (const k of ['lightbox', 'modal', 'typing']) expect(allowed('find', { ...none, [k]: true })).toBe(false);
    expect(allowed(null, none)).toBe(false);
  });
  it('keeps only Find in the table, pricing and selling views', () => {
    for (const v of ['table', 'pricing', 'selling']) {
      expect(allowed('find', { ...none, [v]: true })).toBe(true);
      expect(allowed('owner', { ...none, [v]: true })).toBe(false);
      expect(allowed('extend', { ...none, [v]: true })).toBe(false);
    }
  });
  it('picks the selected cards before the open one', () => {
    expect(plain(target(['a', 'b'], 'c'))).toEqual({ ids: ['a', 'b'], picking: true });
    expect(plain(target(null, 'c'))).toEqual({ ids: ['c'], picking: false });
    expect(target(null, null)).toBeNull();
  });
  it('selects only on a binder page', () => {
    const ok = { view: 'pages', hasBinder: true, isCase: false, special: false, swap: false, mode: 'ready' };
    expect(canExtend(ok)).toBe(true);
    for (const o of [{ view: 'list' }, { hasBinder: false }, { isCase: true }, { special: true }, { swap: true }, { mode: 'loading' }]) expect(canExtend({ ...ok, ...o })).toBe(false);
  });
});

describe('extending a selection', () => {
  const base = { filled: [1, 2, 4, 5, 9], cols: 3, bid: 'b', page: 1, kb: null, picking: false, focused: null, open: null };
  it('starts at the focused pocket, then the open card, then the first or last', () => {
    expect(plain(extend({ ...base, key: 'ArrowRight', focused: 2 }))).toEqual({ kb: { bid: 'b', page: 1, anchor: 2, cur: 2 }, start: true, slots: [2] });
    expect(extend({ ...base, key: 'ArrowRight', open: 4 })?.kb.anchor).toBe(4);
    expect(extend({ ...base, key: 'ArrowRight' })?.kb.anchor).toBe(1);
    expect(extend({ ...base, key: 'ArrowLeft' })?.kb.anchor).toBe(9);
  });
  it('does not start a selection when one is under way', () => {
    expect(extend({ ...base, key: 'ArrowRight', focused: 2, picking: true })?.start).toBe(false);
  });
  it('grows from the anchor and shrinks back', () => {
    const kb = { bid: 'b', page: 1, anchor: 2, cur: 2 };
    const grown = extend({ ...base, key: 'ArrowDown', kb, picking: true });
    expect(plain(grown)).toEqual({ kb: { bid: 'b', page: 1, anchor: 2, cur: 5 }, start: false, slots: [2, 4, 5] });
    expect(extend({ ...base, key: 'ArrowUp', kb: grown?.kb, picking: true })?.slots).toEqual([2]);
  });
  it('stays put at the edge, and starts over on another page or after the selection ended', () => {
    const kb = { bid: 'b', page: 1, anchor: 2, cur: 9 };
    expect(extend({ ...base, key: 'ArrowRight', kb, picking: true })?.kb.cur).toBe(9);
    expect(extend({ ...base, key: 'ArrowRight', kb, picking: true, page: 2, focused: 4 })?.kb.anchor).toBe(4);
    expect(extend({ ...base, key: 'ArrowRight', kb, picking: false, focused: 4 })?.start).toBe(true);
  });
  it('does nothing on an empty page', () => {
    expect(extend({ ...base, filled: [], key: 'ArrowRight' })).toBeNull();
  });
});

describe('pocket number keys', () => {
  it('maps digit keys by physical key to pocket', () => {
    expect(shortcut({ key: '1', code: 'Digit1' })).toBe('pocket');
    expect(shortcut({ key: '!', code: 'Digit1', shiftKey: true })).toBe('pocket');
    expect(shortcut({ key: '7', code: 'Numpad7' })).toBe('pocket');
  });
  it('ignores digits with Ctrl, Meta, Alt or auto-repeat', () => {
    expect(shortcut({ key: '1', code: 'Digit1', ctrlKey: true })).toBeNull();
    expect(shortcut({ key: '1', code: 'Digit1', metaKey: true })).toBeNull();
    expect(shortcut({ key: '1', code: 'Digit1', altKey: true })).toBeNull();
    expect(shortcut({ key: '1', code: 'Digit1', repeat: true })).toBeNull();
    expect(shortcut({ key: '/', code: 'Digit7', shiftKey: true })).toBe('find');
    expect(shortcut({ key: 'a', code: 'KeyA' })).toBeNull();
  });
  it('reads digits', () => {
    expect(digit({ code: 'Digit0' })).toBe(0);
    expect(digit({ code: 'Numpad9' })).toBe(9);
    expect(digit({ code: 'KeyA' })).toBeNull();
    expect(digit({})).toBeNull();
  });
  it('knows modifier presses', () => {
    for (const key of ['Shift', 'Control', 'Meta', 'Alt']) expect(holds({ key })).toBe(true);
    expect(holds({ key: 'a' })).toBe(false);
    expect(holds({ key: 'ArrowRight' })).toBe(false);
  });
  const base = { bid: 'b', page: 1, pending: null };
  it('acts straight away on 9 pockets, only on filled ones', () => {
    const f = [1, 4, 9];
    expect(pocketPress({ ...base, d: 4, n: 9, filled: f }).slot).toBe(4);
    expect(pocketPress({ ...base, d: 5, n: 9, filled: f })).toEqual({ slot: null, add: false, pending: null });
    expect(pocketPress({ ...base, d: 0, n: 9, filled: f }).slot).toBeNull();
    expect(pocketPress({ ...base, d: 7, n: 4, filled: [1, 2, 3, 4] }).slot).toBeNull();
    expect(pocketPress({ ...base, d: 2, n: 12, filled: [2] }).slot).toBe(2);
  });
  it('waits for a second digit on 16 pockets', () => {
    const filled = [1, 10, 12];
    const first = pocketPress({ ...base, d: 1, n: 16, filled });
    expect(first.slot).toBeNull();
    expect(plain(first.pending)).toEqual({ digits: 1, add: false, bid: 'b', page: 1 });
    expect(pocketPress({ ...base, d: 2, n: 16, filled, pending: first.pending })).toEqual({ slot: 12, add: false, pending: null });
    expect(pocketPress({ ...base, d: 3, n: 16, filled, pending: first.pending }).slot).toBeNull();
    expect(pocketPress({ ...base, d: 7, n: 16, filled, pending: first.pending }).slot).toBeNull();
    expect(pocketPress({ ...base, d: 0, n: 16, filled, pending: first.pending }).slot).toBe(10);
  });
  it('ignores a pending digit from another page or binder', () => {
    const pending = { digits: 1, add: false, bid: 'b', page: 2 };
    expect(pocketPress({ ...base, d: 2, n: 16, filled: [12], pending }).pending).toBeNull();
    expect(pocketPress({ ...base, d: 2, n: 16, filled: [12], pending }).slot).toBeNull();
    const r = pocketPress({ ...base, d: 1, n: 16, filled: [1], pending: { ...pending, page: 1, bid: 'x' } });
    expect(r.pending).not.toBeNull();
  });
  it('adds when either press had Shift', () => {
    const filled = [1, 12];
    const first = pocketPress({ ...base, d: 1, n: 16, filled, add: true });
    expect(first.pending?.add).toBe(true);
    expect(pocketPress({ ...base, d: 2, n: 16, filled, pending: first.pending }).add).toBe(true);
    const plainFirst = pocketPress({ ...base, d: 1, n: 16, filled });
    expect(pocketPress({ ...base, d: 2, n: 16, filled, add: true, pending: plainFirst.pending }).add).toBe(true);
    expect(pocketPress({ ...base, d: 4, n: 9, filled: [4], add: true }).add).toBe(true);
  });
  it('picks a waiting digit once it is due', () => {
    const pending = { digits: 1, add: false, bid: 'b', page: 1 };
    expect(pocketDue({ pending, n: 16, filled: [1], bid: 'b', page: 1 })).toBe(1);
    expect(pocketDue({ pending, n: 16, filled: [2], bid: 'b', page: 1 })).toBeNull();
    expect(pocketDue({ pending, n: 16, filled: [1], bid: 'b', page: 2 })).toBeNull();
    expect(pocketDue({ pending, n: 16, filled: [1], bid: 'c', page: 1 })).toBeNull();
    expect(pocketDue({ pending: null, n: 16, filled: [1], bid: 'b', page: 1 })).toBeNull();
  });
  it('starts, replaces or extends the selection', () => {
    const a = pocketPick({ slot: 3, add: false, bid: 'b', page: 1, picking: false });
    expect(a).toEqual({ kb: { bid: 'b', page: 1, anchor: 3, cur: 3 }, start: true, keep: false });
    expect(pocketPick({ slot: 3, add: true, bid: 'b', page: 1, picking: true })).toMatchObject({ start: false, keep: true });
    expect(pocketPick({ slot: 3, add: false, bid: 'b', page: 1, picking: true })).toMatchObject({ start: false, keep: false });
  });
});
