import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/formsync.js is a plain browser script; load it the way the page does.
type Field = { name: string; value: string; defaultValue: string };
type Opt = { value: string; selected: boolean; defaultSelected: boolean };
type El = { tagName: string; value: string; defaultValue?: string; options?: Opt[]; type?: string; checked?: boolean; defaultChecked?: boolean; readOnly?: boolean; disabled?: boolean };
const sandbox = {
  window: {} as {
    BinderFormSync: {
      SELECTS: Record<string, string>;
      updates: (fields: Field[], card: Record<string, unknown>) => Record<string, string>;
      shownValue: (el: El) => string;
      markShown: (el: El) => void;
      show: (el: El, value: string) => boolean;
      edited: (elements: El[]) => boolean;
      unsaved: (fields: El[], draft: { imageId?: string | null } | null) => boolean;
      saveDisabled: (state: { dirty?: boolean; saving?: boolean }) => boolean;
      changedSince: (elements: (El & { name?: string })[], sent: Record<string, string>) => Record<string, string>;
      markSaved: (elements: (El & { name?: string })[], sent: Record<string, string>) => Record<string, string>;
    };
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/formsync.js'), 'utf8'), sandbox);
const { updates, shownValue, markShown, show, edited, unsaved, saveDisabled, changedSince, markSaved } = sandbox.window.BinderFormSync;

/** A dropdown as the drawer draws it: `drawn` is the option marked chosen, `value` what it shows now. */
const dropdown = (values: string[], drawn: string | null, value = drawn ?? values[0]): El => ({
  tagName: 'SELECT',
  value,
  options: values.map((v) => ({ value: v, selected: v === value, defaultSelected: v === drawn })),
});

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

  it('reads, shows and saves a dropdown’s value like a text field’s', () => {
    // What it showed: the option drawn as chosen, or the first when none is.
    expect(shownValue(dropdown(['binder', 'listed', 'sold'], 'listed', 'sold'))).toBe('listed');
    expect(shownValue(dropdown(['binder', 'listed', 'sold'], null))).toBe('binder');
    expect(shownValue({ tagName: 'TEXTAREA', value: 'new', defaultValue: 'old' })).toBe('old');
    // The card's new value is shown as unchanged.
    const status = dropdown(['binder', 'listed', 'sold'], 'binder');
    expect(show(status, 'sold')).toBe(true);
    expect([status.value, shownValue(status)]).toEqual(['sold', 'sold']);
    // A value the dropdown has no choice for leaves it as it is.
    const owner = dropdown(['Justin', 'Sam'], 'Justin');
    expect(show(owner, 'Alex')).toBe(false);
    expect([owner.value, shownValue(owner)]).toEqual(['Justin', 'Justin']);
    const notes: El = { tagName: 'TEXTAREA', value: 'a', defaultValue: 'a' };
    expect(show(notes, 'b')).toBe(true);
    expect(notes).toMatchObject({ value: 'b', defaultValue: 'b' });
    // After a save, what each field holds counts as unchanged.
    const picked = dropdown(['binder', 'listed', 'sold'], 'binder', 'listed');
    markShown(picked);
    expect(shownValue(picked)).toBe('listed');
    const typed: El = { tagName: 'INPUT', value: 'Charizard', defaultValue: 'Charmander' };
    markShown(typed);
    expect(typed.defaultValue).toBe('Charizard');
  });

  it('tells whether the person changed anything, so closing the drawer can ask first', () => {
    const notes = (value: string): El => ({ tagName: 'TEXTAREA', value, defaultValue: 'old note' });
    const status = dropdown(['binder', 'listed', 'sold'], 'binder');
    const placeholder = (checked: boolean): El => ({ tagName: 'INPUT', type: 'checkbox', value: 'on', defaultValue: 'on', checked, defaultChecked: false });
    expect(edited([notes('old note'), status, placeholder(false)])).toBe(false);
    expect(edited([notes('a long note about centering'), status])).toBe(true);
    expect(edited([notes('old note'), dropdown(['binder', 'listed', 'sold'], 'binder', 'sold')])).toBe(true);
    expect(edited([placeholder(true)])).toBe(true);
    // A ticked box that's been saved isn't a change any more.
    const ticked = placeholder(true);
    markShown(ticked);
    expect([ticked.defaultChecked, edited([ticked])]).toEqual([true, false]);
    // Typed and then put back as it was: nothing to lose.
    expect(edited([notes('old note')])).toBe(false);
    // Fields the person can't change, buttons and file pickers don't count.
    const other = [
      { tagName: 'INPUT', value: '2024-01-01', defaultValue: '', readOnly: true },
      { tagName: 'INPUT', type: 'file', value: 'C:\\fakepath\\a.jpg', defaultValue: '' },
      { tagName: 'BUTTON', type: 'submit', value: 'x', defaultValue: '' },
      { tagName: 'INPUT', value: 'x', defaultValue: '', disabled: true },
      { tagName: 'INPUT', type: 'search', value: 'lapras 131', defaultValue: 'Lapras' },
    ];
    expect(edited(other)).toBe(false);
  });

  it('counts a price being added or a move being set up, and a new card’s photo, as something to lose', () => {
    const amount = (value: string): El => ({ tagName: 'INPUT', type: 'number', value, defaultValue: '' });
    const where = { tagName: 'INPUT', value: 'PriceCharting', defaultValue: 'PriceCharting' };
    const page = (value: string): El => ({ tagName: 'INPUT', type: 'number', value, defaultValue: '3' });
    expect(unsaved([amount(''), where, page('3')], null)).toBe(false);
    expect(unsaved([amount('42.50'), where, page('3')], null)).toBe(true);
    expect(unsaved([amount(''), where, page('5')], null)).toBe(true);
    // A new card: nothing typed, but a photo chosen.
    expect(unsaved([amount('')], { imageId: null })).toBe(false);
    expect(unsaved([amount('')], { imageId: 'a'.repeat(32) })).toBe(true);
    // A new card redrawn after its name was typed (choosing and removing a photo): still something to lose.
    const name = (value: string): El => ({ tagName: 'INPUT', value, defaultValue: value });
    const released: El = { tagName: 'INPUT', value: 'Filled in after saving', defaultValue: 'Filled in after saving', readOnly: true };
    expect(unsaved([name('Pikachu'), released], { imageId: null })).toBe(true);
    expect(unsaved([name(' '), released], { imageId: null })).toBe(false);
    // A saved card redrawn shows what it has: nothing to lose.
    expect(unsaved([name('Pikachu')], null)).toBe(false);
  });

  it('keeps Add card / Save changes off while a save is on its way, even after more typing', () => {
    expect(saveDisabled({ dirty: false, saving: false })).toBe(true);
    expect(saveDisabled({ dirty: true, saving: false })).toBe(false);
    // Typed during the save: still off until it's answered, so a second save can't add the card twice.
    expect(saveDisabled({ dirty: true, saving: true })).toBe(true);
    expect(saveDisabled({})).toBe(true);
  });

  it('after a save, counts as saved only what was sent: text typed meanwhile stays to be saved', () => {
    const field = (name: string, value: string, defaultValue: string) => ({ tagName: 'TEXTAREA', name, value, defaultValue });
    const sent = { notes: 'first', name: 'Lapras' };
    // Notes typed into while the save was on its way; the name as sent (trailing space trimmed when read).
    const notes = field('notes', 'first and more', 'old');
    const name = field('name', 'Lapras ', 'Lapra');
    const placeholder = { tagName: 'INPUT', type: 'checkbox', value: 'on', checked: true, defaultChecked: false };
    expect(changedSince([notes, name], sent)).toEqual({ notes: 'first and more' });
    expect(markSaved([notes, name, placeholder as El & { name?: string }], sent)).toEqual({ notes: 'first and more' });
    expect([notes.defaultValue, name.defaultValue, placeholder.defaultChecked]).toEqual(['old', 'Lapras ', true]);
    expect(edited([notes, name])).toBe(true);
    // Nothing typed meanwhile: everything counts as saved.
    const quiet = field('notes', 'first', 'old');
    expect(markSaved([quiet], sent)).toEqual({});
    expect(edited([quiet])).toBe(false);
  });
});
