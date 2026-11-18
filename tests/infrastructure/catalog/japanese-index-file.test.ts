import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { JapaneseIndexData } from '#domain/catalog/japanese.ts';
import { JAPANESE_INDEX_FILE, JapaneseIndexFile } from '#infrastructure/catalog/japanese-index-file.ts';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-index-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const data: JapaneseIndexData = {
  version: 1,
  completedAt: '2026-11-18T21:05:00.000Z',
  sets: [
    {
      set: { groupId: 2, name: 'Pokemon Card 151', fullName: 'SV2a: Pokemon Card 151', code: 'SV2a', released: '2023-06-16', modifiedOn: 'm1', fetchedAt: '2026-11-18T21:00:00.000Z' },
      cards: [
        { productId: 223, name: 'Pikachu', variant: '', number: '025/165', rarity: 'Common' },
        { productId: 224, name: 'Eevee', variant: 'Poke Ball Pattern', number: '133/165', rarity: null },
      ],
    },
    { set: { groupId: 3, name: 'Old', fullName: 'Old', code: null, released: null, modifiedOn: '', fetchedAt: '2026-11-18T21:00:00.000Z' }, cards: [] },
  ],
};

describe('the Japanese card index file', () => {
  it('saves and loads the index, leaving no temporary file behind', async () => {
    const file = new JapaneseIndexFile(dir);
    await file.save(data);
    assert.deepEqual(fs.readdirSync(dir), [JAPANESE_INDEX_FILE]);
    assert.deepEqual(await file.load(), data);
    await file.save({ ...data, completedAt: null });
    assert.equal((await file.load())?.completedAt, null);
    assert.deepEqual(fs.readdirSync(dir), [JAPANESE_INDEX_FILE]);
  });

  it('keeps only the fields lookups need, in a compact file', async () => {
    await new JapaneseIndexFile(dir).save(data);
    const text = fs.readFileSync(path.join(dir, JAPANESE_INDEX_FILE), 'utf8');
    assert.ok(!text.includes('\n'));
    assert.deepEqual(JSON.parse(text).sets[0].cards[0], [223, 'Pikachu', '', '025/165', 'Common']);
  });

  it('loads nothing when the file is missing, damaged or from another version', async () => {
    const file = new JapaneseIndexFile(dir);
    assert.equal(await file.load(), null);
    const at = path.join(dir, JAPANESE_INDEX_FILE);
    for (const bad of ['{nope', '[]', 'null', JSON.stringify({ v: 2, completedAt: null, sets: [] }), JSON.stringify({ v: 1, completedAt: 5, sets: [] }), JSON.stringify({ v: 1, completedAt: null, sets: [{ g: 'x' }] }), JSON.stringify({ v: 1, completedAt: null, sets: [{ g: 1, n: 'a', f: 'a', c: null, r: null, m: '', t: '', cards: [[1, 'a']] }] })]) {
      fs.writeFileSync(at, bad);
      assert.equal(await file.load(), null, bad);
    }
  });
});
