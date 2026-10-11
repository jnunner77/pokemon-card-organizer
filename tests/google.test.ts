import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/google.js is a plain browser script; load it the way the page does.
type Card = Record<string, unknown>;
interface Google {
  cardWords: (c: Card) => string;
  imagesUrl: (c: Card) => string;
  priceUrl: (c: Card) => string;
  detailsUrl: (c: Card, missing?: string[]) => string;
  missing: (c: Card) => { picture: boolean; price: boolean; details: string[] };
}
const sandbox = { window: {} as { BinderGoogle: Google } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/google.js'), 'utf8'), sandbox);
const G = sandbox.window.BinderGoogle;
const q = (u: string) => new URL(u).searchParams.get('q');

const snorlax = { name: 'Snorlax', set: 'Lost Origin Trainer Gallery', setCode: 'LOR', number: 'TG10/TG30', variant: 'Holo', language: 'English', grader: 'Raw', status: 'binder', prices: [] };

describe('searching Google for what a card is missing', () => {
  it('names the card as the binder has it: name, set, number, variant, language and grade', () => {
    expect(G.cardWords(snorlax)).toBe('Snorlax Lost Origin Trainer Gallery TG10/TG30 Holo pokemon card');
    expect(G.cardWords({ name: ' Pikachu ', setCode: 'SVP', number: '085', variant: 'Regular', language: 'Japanese', grader: 'PSA', grade: '10' })).toBe('Pikachu SVP 085 Japanese PSA 10 pokemon card');
    expect(G.cardWords({ name: 'Mew', grader: 'PSA', grade: '' })).toBe('Mew pokemon card');
  });

  it('searches Google Images for its picture, and Google for its price or details', () => {
    expect(G.imagesUrl(snorlax)).toMatch(/^https:\/\/www\.google\.com\/search\?tbm=isch&q=/);
    expect(q(G.imagesUrl(snorlax))).toBe('Snorlax Lost Origin Trainer Gallery TG10/TG30 Holo pokemon card');
    expect(G.priceUrl(snorlax)).not.toContain('tbm=');
    expect(q(G.priceUrl(snorlax))).toBe('Snorlax Lost Origin Trainer Gallery TG10/TG30 Holo pokemon card price');
    expect(q(G.detailsUrl(snorlax, ['rarity', 'illustrator']))).toBe('Snorlax Lost Origin Trainer Gallery TG10/TG30 Holo pokemon card rarity illustrator');
    expect(q(G.detailsUrl({ name: 'Mew' }))).toBe('Mew pokemon card set set code rarity illustrator');
    // Characters that mean something in a URL are encoded.
    expect(q(G.priceUrl({ name: 'Farfetch’d & Sirfetch’d #1?' }))).toBe('Farfetch’d & Sirfetch’d #1? pokemon card price');
  });

  it('knows what a card is missing', () => {
    expect(G.missing(snorlax)).toEqual({ picture: true, price: true, details: ['rarity', 'illustrator'] });
    const full = { ...snorlax, rarity: 'Rare', artist: 'Kouki Saitou', officialImageId: 'a1', prices: [{ type: 'market', amount: 14.2 }] };
    expect(G.missing(full)).toEqual({ picture: false, price: false, details: [] });
    // The person's own photo counts as a picture; a paid price isn't its value; blanks are blank.
    expect(G.missing({ ...full, officialImageId: null, imageId: 'p1', rarity: '  ', prices: [{ type: 'paid', amount: 5 }] })).toEqual({ picture: false, price: true, details: ['rarity'] });
    // A card sold or traded away needs no price.
    expect(G.missing({ ...snorlax, status: 'sold' }).price).toBe(false);
  });
});
