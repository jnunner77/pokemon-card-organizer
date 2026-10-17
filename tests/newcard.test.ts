import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/newcard.js is a plain browser script; load it the way the page does.
type Where = { target: string; key?: string | null; sel: string | null; draftKey?: string | null; added?: Record<string, string> | null };
const sandbox = { window: {} as { BinderNewCard: { photoTarget: (w: Where) => string; placeholderAfterAdd: (sent: boolean, now: boolean) => boolean | null } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/newcard.js'), 'utf8'), sandbox);
const { photoTarget, placeholderAfterAdd } = sandbox.window.BinderNewCard;

describe('the Placeholder switch changed while a new card was being added', () => {
  it('is saved on the added card when it differs from what the card was added with', () => {
    expect(placeholderAfterAdd(false, true)).toBe(true);
    expect(placeholderAfterAdd(true, false)).toBe(false);
  });
  it('leaves the card alone when it was not changed', () => {
    expect(placeholderAfterAdd(false, false)).toBeNull();
    expect(placeholderAfterAdd(true, true)).toBeNull();
  });
});

describe("a new card's photo that's ready after the card was added", () => {
  it('goes on a saved card it was picked for, as before', () => {
    expect(photoTarget({ target: 'c1', sel: 'c2', added: { k1: 'c9' } })).toBe('c1');
  });

  it('goes on the draft while that same new card is still open', () => {
    expect(photoTarget({ target: '__new', key: 'k1', sel: '__new', draftKey: 'k1' })).toBe('draft');
    expect(photoTarget({ target: '__new', key: null, sel: '__new', draftKey: 'k1' })).toBe('draft');
  });

  it('goes on the card that draft became, whether its drawer is open or the person moved on', () => {
    const added = { k1: 'c1', k2: 'c2' };
    expect(photoTarget({ target: '__new', key: 'k1', sel: 'c1', added })).toBe('c1');
    expect(photoTarget({ target: '__new', key: 'k1', sel: '__new', draftKey: 'k3', added })).toBe('c1');
    // Two cards added one after the other: each photo goes on its own card.
    expect(photoTarget({ target: '__new', key: 'k2', sel: 'c2', added })).toBe('c2');
  });

  it("says so when that new card was closed without being added", () => {
    expect(photoTarget({ target: '__new', key: 'k1', sel: null, added: {} })).toBe('gone');
    expect(photoTarget({ target: '__new', key: 'k1', sel: '__new', draftKey: 'k3', added: null })).toBe('gone');
  });
});
