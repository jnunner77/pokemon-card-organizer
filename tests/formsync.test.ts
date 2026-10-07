import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/formsync.js is a plain browser script; load it the way the page does.
type Field = { name: string; value: string; defaultValue: string };
const sandbox = { window: {} as { BinderFormSync: { updates: (fields: Field[], card: Record<string, unknown>) => Record<string, string> } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/formsync.js'), 'utf8'), sandbox);
const { updates } = sandbox.window.BinderFormSync;

const shown = (name: string, value: string): Field => ({ name, value, defaultValue: value });

describe('the open card drawer when the card changes', () => {
  it('shows the new value in fields the person hasn’t edited', () => {
    expect(updates([shown('variant', ''), shown('set', 'Ascended Heroes'), shown('name', 'Rayquaza')], { name: 'Rayquaza', set: 'Pokemon Ascended Heroes', variant: 'Ball' }))
      .toEqual({ variant: 'Ball', set: 'Pokemon Ascended Heroes' });
  });

  it('keeps what the person typed', () => {
    expect(updates([{ name: 'variant', value: 'Poke Ball', defaultValue: '' }], { variant: 'Ball' })).toEqual({});
  });

  it('treats a missing value as blank and leaves other fields alone', () => {
    expect(updates([shown('artist', 'Ken Sugimori'), shown('variant', '')], { artist: null })).toEqual({ artist: '' });
    expect(updates([shown('condition', 'Near Mint')], { condition: 'Played' })).toEqual({});
  });
});
