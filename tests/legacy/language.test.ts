import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { matchedOtherCatalog as serverMatchedOtherCatalog, matchLanguage } from '../../src/domain/catalog/japanese.ts';

// public/language.js and public/lookup.js are plain browser scripts; load them the way the page does.
interface Language {
  catalogLanguage: (l?: string | null) => 'en' | 'ja' | null;
  looksUp: (l?: string | null) => boolean;
  param: (l?: string | null) => 'en' | 'ja';
  ofId: (id?: string | null) => 'en' | 'ja';
  label: (id?: string | null) => string;
  matchedOtherCatalog: (card: Record<string, unknown>) => boolean;
}
const sandbox = { window: {} as { BinderLanguage: Language; BinderLookup: { binderCard: (c: Record<string, unknown>, p: undefined, loc: { binderId: string }, owner: string, at: string, language?: string) => Record<string, unknown> } } };
for (const file of ['language.js', 'lookup.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8'), sandbox);
const { catalogLanguage, looksUp, param, ofId, label, matchedOtherCatalog } = sandbox.window.BinderLanguage;

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

  it("tells a card whose match is from the other language's catalog, as the server does", () => {
    const full = { name: 'Charizard ex', number: '201/165', set: 'Pokemon Card 151', setCode: 'SV2a', rarity: 'Rare', artist: 'PLANETA', released: '2023-06-16' };
    const at = (id: unknown, language?: unknown) => ({ ...full, language, details: { result: 'filled', v: 3, id, checkedAt: '2026-11-18T00:00:00Z' } });
    // an English card holding an English match later set to Japanese, complete: wanted again
    expect(matchedOtherCatalog(at('sv03.5-006', 'Japanese'))).toBe(true);
    expect(matchedOtherCatalog(at('ja-2-222', 'English'))).toBe(true);
    expect(matchedOtherCatalog(at('ja-2-222', ''))).toBe(true);
    expect(matchedOtherCatalog(at('ja-2-222', 'Japanese'))).toBe(false);
    expect(matchedOtherCatalog(at('sv03.5-006', 'English'))).toBe(false);
    expect(matchedOtherCatalog(at('ja-2-222', 'Korean'))).toBe(false);
    expect(matchedOtherCatalog({ ...full, language: 'Japanese' })).toBe(false);
  });

  it('agrees with the server on which cards hold a match from the other catalog', () => {
    const ids: unknown[] = [undefined, null, '', 0, 'sv03.5-006', 'ja-2-222', 'ja-x-1', 'ja-1234567890-1', 'ja-1-1234567890123', 'JA-2-222', ' ja-2-222'];
    const languages: unknown[] = [undefined, null, '', 'English', 'en', 'Japanese', 'JP', 'ja', 'Korean', 'Chinese'];
    const details: unknown[] = [undefined, null, 'x', [], ...ids.map((id) => ({ id })), ...ids.map((id) => ({ id, chosen: true, v: 2 }))];
    let checked = 0;
    for (const language of languages)
      for (const d of details) {
        const card: Record<string, unknown> = { name: 'Pikachu', number: '25', language, details: d };
        expect(matchedOtherCatalog(card), JSON.stringify(card)).toBe(serverMatchedOtherCatalog(card));
        checked++;
      }
    expect(checked).toBeGreaterThan(200);
    for (const id of ids) if (typeof id === 'string' && id) expect(ofId(id), id).toBe(matchLanguage(id));
  });
});
