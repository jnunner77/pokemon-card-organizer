import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/where.js is a plain browser script; load it the way the page does.
type Field = { value: string };
type Where = {
  html: (id: string, places: string[], value: string | undefined, placeholder?: string) => string;
  read: (select: Field | null, custom: Field | null) => string;
  toggle: (select: unknown, doc: unknown) => void;
  CUSTOM: string;
};
const sandbox = { window: {} as { BinderWhere: Where } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/where.js'), 'utf8'), sandbox);
const { html, read, toggle, CUSTOM } = sandbox.window.BinderWhere;

const places = ['eBay', 'Card show', 'PriceCharting'];
const chosen = (h: string) => /<option value="([^"]*)" selected>/.exec(h)?.[1];
const customField = (h: string) => /<input [^>]*>/.exec(h)?.[0] ?? '';

describe('the Where dropdown', () => {
  it('lists the usual places, a blank and Custom…, with the saved place chosen', () => {
    const h = html('n_where', places, 'PriceCharting');
    expect(h).toContain('<select id="n_where" data-where>');
    expect(h).toContain('<option value="eBay">eBay</option>');
    expect(h).toContain('<option value="">—</option>');
    expect(h).toContain(`<option value="${CUSTOM}">Custom…</option>`);
    expect(chosen(h)).toBe('PriceCharting');
    expect(customField(h)).toMatch(/ hidden>$/);
  });

  it('opens a place not in the list as Custom… with its text in the shown field', () => {
    const h = html('e_where', places, 'Dad\'s "garage" sale');
    expect(chosen(h)).toBe(CUSTOM);
    expect(customField(h)).toContain('id="e_where_custom"');
    expect(customField(h)).toContain('value="Dad&#39;s &quot;garage&quot; sale"');
    expect(customField(h)).not.toContain('hidden');
  });

  it('chooses the blank when nothing is saved', () => {
    expect(chosen(html('bb_where', places, ''))).toBe('');
    expect(chosen(html('bb_where', places, undefined))).toBe('');
  });

  it('saves the chosen place, or the typed one with Custom…', () => {
    expect(read({ value: 'eBay' }, { value: 'ignored' })).toBe('eBay');
    expect(read({ value: CUSTOM }, { value: '  Flea market ' })).toBe('Flea market');
    expect(read({ value: CUSTOM }, null)).toBe('');
    expect(read({ value: '' }, { value: '' })).toBe('');
    expect(read(null, null)).toBe('');
  });

  it('shows and focuses the typing field only while Custom… is chosen', () => {
    const custom = { hidden: true, focused: 0, focus() { this.focused++; } };
    const doc = { getElementById: (id: string) => (id === 'qs_where_custom' ? custom : null) };
    const select = { id: 'qs_where', value: CUSTOM, matches: (s: string) => s === 'select[data-where]' };
    toggle(select, doc);
    expect(custom.hidden).toBe(false);
    expect(custom.focused).toBe(1);
    select.value = 'eBay';
    toggle(select, doc);
    expect(custom.hidden).toBe(true);
    expect(custom.focused).toBe(1);
    toggle({ id: 'x', value: CUSTOM, matches: () => false }, doc); // not a Where dropdown
  });
});
