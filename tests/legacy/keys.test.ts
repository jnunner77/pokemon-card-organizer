import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/keys.js is a plain browser script; load it the way the page does.
type Ev = { key?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };
type Keys = {
  shortcut: (e: Ev) => string | null;
  step: (filled: number[], cols: number, from: number | null, key: string) => number | null;
  range: (filled: number[], a: number, b: number) => number[];
  modLabel: (platform: string) => string;
};
const sandbox = { window: {} as { BinderKeys: Keys } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/keys.js'), 'utf8'), sandbox);
const { shortcut, step, range, modLabel } = sandbox.window.BinderKeys;
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
