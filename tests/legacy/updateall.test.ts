import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/updateall.js is a plain browser script; load it the way the page does.
type Card = Record<string, unknown>;
interface UpdateAll {
  KINDS: { k: string; label: string; scope: string | null }[];
  needsPicture: (c: Card) => boolean;
  progress: (pricing: Card, details: Card) => string[];
  lastPictures: (pricing: Card) => string;
}
const sandbox = { window: {} as { BinderUpdateAll: UpdateAll } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/updateall.js'), 'utf8'), sandbox);
const U = sandbox.window.BinderUpdateAll;

describe('Settings → Update all cards', () => {
  it('offers everything, prices, pictures and details, the first three through the price update', () => {
    expect(U.KINDS.map((K) => [K.label, K.scope])).toEqual([
      ['Everything', 'all'],
      ['Prices', 'prices'],
      ['Pictures', 'pictures'],
      ['Details', null],
    ]);
  });

  it("visits the cards a picture update would: no official picture, or TCGdex's smaller one", () => {
    expect(U.needsPicture({ status: 'binder' })).toBe(true);
    expect(U.needsPicture({ status: 'binder', officialImageId: 'a', pricing: { imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/1_in_1000x1000.jpg' } })).toBe(false);
    expect(U.needsPicture({ status: 'binder', officialImageId: 'a', pricing: { imageUrl: 'https://assets.tcgdex.net/en/sv/sv03.5/131/high.png' } })).toBe(true);
    expect(U.needsPicture({ status: 'binder', officialImageId: 'a', pricing: { imageUrl: 'https://images.pokemontcg.io/sv3pt5/131_hires.png' } })).toBe(false);
    expect(U.needsPicture({ status: 'binder', officialImageId: 'a', pricing: { imageUrl: 'https://storage.googleapis.com/images.pricecharting.com/x/1600.jpg' } })).toBe(false);
    // Sold, traded, or with automatic pricing turned off: left alone (the person's photo is no official picture).
    expect(U.needsPicture({ status: 'sold' })).toBe(false);
    expect(U.needsPicture({ status: 'traded' })).toBe(false);
    expect(U.needsPicture({ status: 'binder', imageId: 'p', pricing: { source: 'off' } })).toBe(false);
  });

  it("says what's running, and how the last picture update went", () => {
    expect(U.progress({}, {})).toEqual([]);
    expect(U.progress({ running: true, scope: 'pictures', done: 3, total: 12, current: { card: 'Snorlax LOR TG10' } }, {})).toEqual(['Updating pictures: 3 of 12 cards (now Snorlax LOR TG10)']);
    // A run from before there was a choice updates everything.
    expect(U.progress({ running: true, done: 0, total: 5 }, { running: true, done: 2, total: 9 })).toEqual(['Updating everything: 0 of 5 cards', 'Looking up details: 2 of 9 cards']);
    expect(U.lastPictures({})).toBe('');
    expect(U.lastPictures({ lastPictureRun: { date: '2026-10-11', counts: { updated: 4, noPicture: 1 } } })).toBe('Last picture update 2026-10-11: 4 pictured · 1 still without a picture');
    expect(U.lastPictures({ lastPictureRun: { date: '2026-10-11', ended: 'stopped', counts: { updated: 2 } } })).toBe('Last picture update 2026-10-11 (stopped): 2 pictured');
  });
});
