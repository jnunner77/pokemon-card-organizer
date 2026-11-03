import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/search.js is a plain browser script; load it the way the page does.
interface Card { id: string; name?: string; set?: string; setCode?: string; number?: string; artist?: string; page?: number; slot?: number; variant?: string }
const stackBox = { window: {} as { BinderStack: { same: (a: Card, b: Card) => boolean } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/stack.js'), 'utf8'), stackBox);
const real = (a: Card, b: Card) => stackBox.window.BinderStack.same(a, b);
const sandbox = { window: {} as { BinderSearch: { search: (cards: Card[], q: string, o?: { limit?: number; order?: (c: Card) => string; same?: (a: Card, b: Card) => boolean }) => { card: Card; score: number; copies: number }[]; norm: (s: string) => string } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/search.js'), 'utf8'), sandbox);
const { search, norm } = sandbox.window.BinderSearch;

const cards: Card[] = [
  { id: 'pika-m22', name: 'Pikachu', set: "McDonald's Collection 2022", setCode: 'M22', number: '7/15', artist: 'Mitsuhiro Arita' },
  { id: 'pika-tef', name: 'Pikachu', set: 'Temporal Forces', setCode: 'TEF', number: '51/162', artist: 'kodama' },
  { id: 'pika-xy', name: 'Pikachu', set: 'XY', setCode: 'XY', number: '42/146' },
  { id: 'bill', name: 'Bill', set: 'Base Set 2', setCode: 'B2', number: '118/130', artist: 'Ken Sugimori' },
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

  it('finds by illustrator, whole word or start of one, ignoring case and accents', () => {
    expect(ids('arita')).toEqual(['pika-m22']);
    expect(ids('SUGI')).toEqual(['bill']);
    expect(ids('Kodamá')).toEqual(['pika-tef']);
    expect(ids('mitsuhiro arita')).toEqual(['pika-m22']);
  });

  it('combines illustrator words with other words', () => {
    expect(ids('pikachu kodama')).toEqual(['pika-tef']);
    expect(ids('pikachu sugimori')).toEqual([]);
  });

  it('ranks a name match above an illustrator-only match', () => {
    const extra: Card[] = [{ id: 'by-ken', name: 'Eevee', artist: 'Ken Sugimori' }, { id: 'ken', name: 'Kenya', set: 'X' }];
    expect(search(extra, 'ken').map((r) => r.card.id)).toEqual(['ken', 'by-ken']);
  });

  it('copes with cards that have no illustrator', () => {
    expect(ids('gust')).toEqual(['gust']);
    expect(ids('arita')).not.toContain('gust');
  });

  it('returns nothing for an empty query and caps the results', () => {
    expect(ids('')).toEqual([]);
    expect(ids('  -  ')).toEqual([]);
    expect(ids('pikachu', { limit: 2 })).toHaveLength(2);
  });
});

describe('copies', () => {
  const pika = (id: string, page: number, slot: number, extra: Partial<Card> = {}): Card =>
    ({ id, name: 'Pikachu', set: "McDonald's Collection 2022", setCode: 'M22', number: '7/15', page, slot, ...extra });
  const pos = (c: Card) => `${String(c.page).padStart(3, '0')}-${String(c.slot).padStart(3, '0')}`;
  const same = (a: Card, b: Card) => a.setCode === b.setCode && a.number === b.number && a.variant === b.variant;
  const copies = [pika('c3', 1, 3), pika('c5', 2, 1), pika('c1', 1, 1), pika('c4', 1, 4), pika('c2', 1, 2)];

  it('lists copies once, at the first place, with how many', () => {
    const r = search(copies, 'pikachu', { order: pos, same });
    expect(r.map((x) => x.card.id)).toEqual(['c1']);
    expect(r[0].copies).toBe(5);
  });

  it('keeps a different number or variant separate', () => {
    const more = [...copies, pika('o', 1, 5, { number: '8/15' }), pika('v', 1, 6, { variant: 'holo' })];
    const r = search(more, 'pikachu', { order: pos, same });
    expect(r.map((x) => [x.card.id, x.copies])).toEqual([['c1', 5], ['o', 1], ['v', 1]]);
  });

  it('counts the limit in distinct cards', () => {
    const many: Card[] = [];
    ['a', 'b', 'c'].forEach((n, i) => { for (let s = 1; s <= 3; s++) many.push(pika(`${n}${s}`, 1, i * 3 + s, { number: `${i + 1}/15` })); });
    const r = search(many, 'pikachu', { order: pos, same, limit: 2 });
    expect(r.map((x) => [x.card.id, x.copies])).toEqual([['a1', 3], ['b1', 3]]);
  });

  it('lists every copy with copies 1 without `same`', () => {
    const r = search(copies, 'pikachu', { order: pos });
    expect(r).toHaveLength(5);
    expect(r.every((x) => x.copies === 1)).toBe(true);
  });

  it('groups greedily when `same` is not transitive', () => {
    const near = (a: Card, b: Card) => Math.abs(Number(a.slot) - Number(b.slot)) <= 1;
    const chain = [pika('s3', 1, 3), pika('s1', 1, 1), pika('s2', 1, 2)];
    const r = search(chain, 'pikachu', { order: pos, same: near });
    expect(r.map((x) => [x.card.id, x.copies])).toEqual([['s1', 2], ['s3', 1]]);
  });

  describe('grouping before matching', () => {
    const mk = (id: string, page: number, slot: number, extra: Partial<Card>): Card => ({ id, name: 'Pikachu', page, slot, ...extra });
    const blank = mk('p1', 1, 1, { number: '58/102' });
    const based = mk('p4', 1, 4, { number: '58/102', set: 'Base Set', setCode: 'BS' });
    const run = (list: Card[], q: string) => search(list, q, { order: pos, same: real }).map((x) => [x.card.id, x.copies]);

    it('is the same for any wording of the query', () => {
      expect(run([based, blank], 'pikachu')).toEqual([['p1', 2]]);
      expect(run([based, blank], 'pikachu base')).toEqual([['p1', 2]]);
    });

    it('is the same whether the number has leading zeros', () => {
      const a = mk('q1', 1, 1, { number: '031/162' }), b = mk('q5', 1, 5, { number: '31/162' });
      expect(run([b, a], 'pikachu 31/162')).toEqual([['q1', 2]]);
      expect(run([b, a], 'pikachu 031/162')).toEqual([['q1', 2]]);
    });

    it('lists only the copies given (a picker without the first one)', () => {
      expect(run([based], 'pikachu base')).toEqual([['p4', 1]]);
    });

    it('ranks a group by its best copy', () => {
      const other = mk('o1', 1, 1, { number: '1/9', set: 'Basement' });
      const lead = mk('g1', 2, 1, { number: '58/102' }), best = mk('g2', 3, 1, { number: '58/102', set: 'Base Set' });
      expect(run([other, best, lead], 'pikachu base')).toEqual([['g1', 2], ['o1', 1]]);
    });
  });
});
