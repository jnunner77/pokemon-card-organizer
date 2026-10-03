import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/search.js is a plain browser script; load it the way the page does.
interface Card { id: string; name?: string; set?: string; setCode?: string; number?: string; page?: number }
const sandbox = { window: {} as { BinderSearch: { search: (cards: Card[], q: string, o?: { limit?: number; order?: (c: Card) => string }) => { card: Card; score: number }[]; norm: (s: string) => string } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/search.js'), 'utf8'), sandbox);
const { search, norm } = sandbox.window.BinderSearch;

const cards: Card[] = [
  { id: 'pika-m22', name: 'Pikachu', set: "McDonald's Collection 2022", setCode: 'M22', number: '7/15' },
  { id: 'pika-tef', name: 'Pikachu', set: 'Temporal Forces', setCode: 'TEF', number: '51/162' },
  { id: 'pika-xy', name: 'Pikachu', set: 'XY', setCode: 'XY', number: '42/146' },
  { id: 'bill', name: 'Bill', set: 'Base Set 2', setCode: 'B2', number: '118/130' },
  { id: 'gust', name: 'Gust of Wind', set: 'Base Set', setCode: 'PBS', number: '93/102' },
  { id: 'zekrom', name: "N's Zekrom", set: 'Mega Evolution Promos', setCode: 'MEP', number: '031' },
  { id: 'shovel', name: 'Hole-Digging Shovel', set: 'Perfect Order', setCode: 'POR', number: '74/88' },
  { id: 'flabebe', name: 'Flabébé', set: 'Pokémon GO', setCode: 'PGO', number: '30/78' },
  { id: 'zoroark', name: 'Hisuian Zoroark V Star', set: 'Crown Zenith', setCode: 'CRZ', number: 'SWSH298' },
  { id: 'lugia', name: 'Lugia EX', set: 'Celebrations', setCode: 'CLV', number: '17/34' },
];
const ids = (q: string, o?: { limit?: number; order?: (c: Card) => string }) => search(cards, q, o).map((r) => r.card.id);

describe('finding a card', () => {
  it('finds by Pokémon name, any case, whole or start of a word', () => {
    expect(ids('pikachu').sort()).toEqual(['pika-m22', 'pika-tef', 'pika-xy']);
    expect(ids('PIKA').sort()).toEqual(['pika-m22', 'pika-tef', 'pika-xy']);
    expect(ids('shovel')).toEqual(['shovel']);
    expect(ids('digging')).toEqual(['shovel']);
  });

  it('ignores accents and punctuation', () => {
    expect(ids('flabebe')).toEqual(['flabebe']);
    expect(ids("n's zekrom")).toEqual(['zekrom']);
    expect(ids('ns')).toEqual(['zekrom']);
    expect(ids('hole-digging')).toEqual(['shovel']);
    expect(ids('pokemon go')).toEqual(['flabebe']);
    expect(norm('Pokémon  N’s Mr. Mime')).toBe('pokemon ns mr mime');
  });

  it('finds by set code, exactly or by its start', () => {
    expect(ids('m22')).toEqual(['pika-m22']);
    expect(ids('PBS')).toEqual(['gust']);
    expect(ids('crz')).toEqual(['zoroark']);
    expect(ids('me')).toContain('zekrom'); // "MEP" starts with "me"
  });

  it('finds by set name', () => {
    expect(ids('temporal forces')).toEqual(['pika-tef']);
    expect(ids('base set').sort()).toEqual(['bill', 'gust']);
    expect(ids('base set 2')).toEqual(['bill']);
    expect(ids('celebrations')).toEqual(['lugia']);
  });

  it('finds by set number: the card number, the full number, or with leading zeros', () => {
    expect(ids('7/15')).toEqual(['pika-m22']);
    expect(ids('118')).toEqual(['bill']);
    expect(ids('31')).toEqual(['zekrom']);
    expect(ids('031')).toEqual(['zekrom']);
    expect(ids('swsh298')).toEqual(['zoroark']);
    expect(ids('15')).toEqual([]); // the set size isn't the card's number
    expect(ids('11')).toEqual([]); // nor is part of a number
  });

  it('needs every word to match something, in any order', () => {
    expect(ids('pikachu m22')).toEqual(['pika-m22']);
    expect(ids('m22 pikachu')).toEqual(['pika-m22']);
    expect(ids('pikachu 42')).toEqual(['pika-xy']);
    expect(ids('pikachu temporal')).toEqual(['pika-tef']);
    expect(ids('pikachu base')).toEqual([]);
    expect(ids('vstar')).toEqual(['zoroark']); // "V Star" written as one word
  });

  it('puts the best match first, then the order given', () => {
    const extra: Card[] = [...cards, { id: 'mega-xy', name: 'Mega Charizard X', set: 'XY Evolutions', setCode: 'EVO', number: '13/108' }];
    // "xy" is Pikachu XY's set code (exact) but only a set-name word for the other card.
    expect(search(extra, 'xy').map((r) => r.card.id)).toEqual(['pika-xy', 'mega-xy']);
    // Equal scores follow the order function (here: where the card sits).
    const where: Record<string, string> = { 'pika-m22': '3', 'pika-tef': '1', 'pika-xy': '2' };
    expect(ids('pikachu', { order: (c) => where[c.id] })).toEqual(['pika-tef', 'pika-xy', 'pika-m22']);
  });

  it('returns nothing for an empty query and caps the results', () => {
    expect(ids('')).toEqual([]);
    expect(ids('  -  ')).toEqual([]);
    expect(ids('pikachu', { limit: 2 })).toHaveLength(2);
  });
});
