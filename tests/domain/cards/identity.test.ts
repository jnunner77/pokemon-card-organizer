import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sameCard } from '#domain/cards/identity.ts';

// The same cases are in tests/legacy/stack.test.ts for the page's copy of the rule (public/stack.js):
// keep the two tables identical.
const base = { name: 'Pikachu', number: '58/102', set: 'Base Set', setCode: 'BS', variant: '', language: 'English' };

const SAME: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['the very same fields', base, { ...base }],
  ['case and punctuation of the name', base, { ...base, name: 'PIKACHU!' }],
  ['accents in the name', { ...base, name: 'Pokémon Center Lady' }, { ...base, name: 'pokemon center lady' }],
  ['51 and 051/162', { ...base, number: '51' }, { ...base, number: '051/162' }],
  ['a blank set and a set', base, { ...base, set: '', setCode: '' }],
  ['a missing set and a set', base, { name: 'Pikachu', number: '58/102', language: 'English' }],
  ['set labels with and without Pokémon', { ...base, setCode: '', set: 'Pokémon Base Set' }, { ...base, setCode: '', set: 'base set' }],
  ['set codes that match, whatever the set labels say', { ...base, set: 'Base Set' }, { ...base, set: 'Base Set (Shadowless)' }],
  ['a blank language and English', base, { ...base, language: '' }],
  ['a missing language and english', { ...base, language: undefined }, { ...base, language: 'english' }],
  ['a different condition, grade, owner and status', { ...base, condition: 'NM', owner: 'Me', status: 'binder' }, { ...base, condition: 'LP', grader: 'PSA', grade: '9', owner: 'Megan', status: 'sold', placeholder: true }],
];

const DIFFERENT: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['name', base, { ...base, name: 'Raichu' }],
  ['number', base, { ...base, number: '59/102' }],
  ['set size', { ...base, number: '51/162' }, { ...base, number: '51/165' }],
  ['set label', { ...base, setCode: '', set: 'Base Set' }, { ...base, setCode: '', set: 'Jungle' }],
  ['set codes', { ...base, setCode: 'BS' }, { ...base, setCode: 'JU' }],
  ['a variant and none', { ...base, variant: 'Holo' }, base],
  ['two variants', { ...base, variant: 'Reverse Holo' }, { ...base, variant: 'Poké Ball' }],
  ['language', base, { ...base, language: 'Japanese' }],
  ['English and another language left blank', { ...base, language: '' }, { ...base, language: 'French' }],
];

describe('the same card', () => {
  for (const [what, a, b] of SAME) {
    it(`is the same card despite ${what}`, () => {
      assert.equal(sameCard(a, b), true);
      assert.equal(sameCard(b, a), true);
    });
  }
  for (const [what, a, b] of DIFFERENT) {
    it(`is another card when the ${what} differs`, () => {
      assert.equal(sameCard(a, b), false);
      assert.equal(sameCard(b, a), false);
    });
  }
});
