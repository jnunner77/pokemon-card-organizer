import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/formsync.js is a plain browser script; load it the way the page does.
type Field = { name: string; value: string; defaultValue: string };
const sandbox = { window: {} as { BinderFormSync: { SELECTS: Record<string, string>; updates: (fields: Field[], card: Record<string, unknown>) => Record<string, string> } } };
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
    expect(updates([shown('released', '2023-01-01'), shown('placeholder', 'on')], { released: '2024-01-01', placeholder: false })).toEqual({});
  });

  it('keeps the dropdowns in step with the card, so Save keeps a sale’s Sold', () => {
    // Logging a sale marked the card sold: the Status dropdown shows it, and so does a later Save.
    expect(updates([shown('status', 'binder'), shown('notes', 'nice')], { status: 'sold', notes: 'nice' })).toEqual({ status: 'sold' });
    // Owner, condition, graded by and language too, when another device changes them.
    expect(updates([shown('owner', 'Justin'), shown('condition', 'Near Mint'), shown('grader', 'Raw'), shown('language', 'English')], { owner: 'Sam', condition: 'Played', grader: 'PSA', language: 'Japanese' }))
      .toEqual({ owner: 'Sam', condition: 'Played', grader: 'PSA', language: 'Japanese' });
  });

  it('keeps a dropdown the person changed, and reads a card without a value as the dropdown’s default', () => {
    expect(updates([{ name: 'status', value: 'listed', defaultValue: 'binder' }], { status: 'sold' })).toEqual({});
    expect(updates([shown('status', 'binder'), shown('grader', 'Raw'), shown('owner', '')], { status: null, grader: '', owner: undefined })).toEqual({});
    expect(updates([shown('status', 'sold')], {})).toEqual({ status: 'binder' });
    expect(sandbox.window.BinderFormSync.SELECTS).toMatchObject({ status: 'binder', condition: 'Near Mint', grader: 'Raw', language: 'English' });
  });
});
