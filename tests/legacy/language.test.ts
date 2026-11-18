import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/language.js and public/lookup.js are plain browser scripts; load them the way the page does.
interface Language {
  catalogLanguage: (l?: string | null) => 'en' | 'ja' | null;
  looksUp: (l?: string | null) => boolean;
  param: (l?: string | null) => 'en' | 'ja';
  ofId: (id?: string | null) => 'en' | 'ja';
  label: (id?: string | null) => string;
}
const sandbox = { window: {} as { BinderLanguage: Language; BinderLookup: { binderCard: (c: Record<string, unknown>, p: undefined, loc: { binderId: string }, owner: string, at: string, language?: string) => Record<string, unknown> } } };
for (const file of ['language.js', 'lookup.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8'), sandbox);
const { catalogLanguage, looksUp, param, ofId, label } = sandbox.window.BinderLanguage;

describe("a card's language and the catalog it is looked up in", () => {
  it('reads blank and English as English, Japanese as Japanese, and others as none', () => {
    expect(['', undefined, 'English', 'en'].map(catalogLanguage)).toEqual(['en', 'en', 'en', 'en']);
    expect(['Japanese', 'JP', 'ja'].map(catalogLanguage)).toEqual(['ja', 'ja', 'ja']);
    expect(catalogLanguage('Korean')).toBeNull();
    expect([looksUp('Japanese'), looksUp(''), looksUp('Korean')]).toEqual([true, true, false]);
    expect([param('Japanese'), param('English'), param('Korean')]).toEqual(['ja', 'en', 'en']);
  });

  it("tells a Japanese match's id from TCGdex's", () => {
    expect([ofId('ja-2-222'), ofId('sv05-051'), ofId('ja-x-1'), ofId(undefined)]).toEqual(['ja', 'en', 'en', 'en']);
    expect([label('ja-2-222'), label('base1-4')]).toEqual(['Japanese', 'English']);
  });

  it('gives a card made from a looked-up card its language', () => {
    const { binderCard } = sandbox.window.BinderLookup;
    const loc = { binderId: 'b1' };
    expect(binderCard({ name: 'Pikachu' }, undefined, loc, 'me', 'now').language).toBe('English');
    expect(binderCard({ name: 'Pikachu' }, undefined, loc, 'me', 'now', 'Japanese').language).toBe('Japanese');
  });
});
