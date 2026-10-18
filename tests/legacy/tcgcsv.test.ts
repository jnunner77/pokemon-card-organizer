import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { printingOf } from '../../server/pricing/catalog.ts';
import { retryPolicy } from '../../server/pricing/sources.ts';
import { TcgCsv, candidateGroups, chooseProduct, ownNumber, productName, setName, tcgPrice, variantFits, type TcgGroup, type TcgPrice, type TcgProduct } from '../../server/pricing/tcgcsv.ts';

retryPolicy.baseMs = 1; // retries happen at once in tests

const fixture = <T>(f: string) => (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tcgcsv', f), 'utf8')) as { results: T }).results;
const groups = fixture<TcgGroup[]>('groups.json');
const tg = fixture<TcgProduct[]>('3172-products.json');
const tgPrices = fixture<TcgPrice[]>('3172-prices.json');
const prismatic = fixture<TcgProduct[]>('23821-products.json');
const prismaticPrices = fixture<TcgPrice[]>('23821-prices.json');

/** tcgcsv.com as the fixtures have it (Lost Origin's Trainer Gallery, 151 and Prismatic Evolutions), counting downloads. */
function fakeTcgcsv(down = false) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    if (down) return new Response('', { status: 500 });
    const m = /tcgplayer\/3\/(groups|(\d+)\/(products|prices))$/.exec(url);
    const file = m ? (m[1] === 'groups' ? 'groups.json' : `${m[2]}-${m[3]}.json`) : '';
    const p = path.join(__dirname, 'fixtures', 'tcgcsv', file);
    return file && fs.existsSync(p) ? new Response(fs.readFileSync(p, 'utf8'), { headers: { 'Content-Type': 'application/json' } }) : new Response('not found', { status: 404 });
  };
  return { fetcher, calls };
}

describe("TCGplayer's catalog from tcgcsv.com", () => {
  it('reads set names, numbers and product names the way TCGplayer writes them', () => {
    expect(setName({ name: 'SWSH11: Lost Origin Trainer Gallery' })).toBe('Lost Origin Trainer Gallery');
    expect(setName({ name: 'SV: Scarlet & Violet 151' })).toBe('Scarlet & Violet 151');
    expect(setName({ name: 'ME: 30th Celebration' })).toBe('30th Celebration');
    expect(setName({ name: 'Base Set (Shadowless)' })).toBe('Base Set (Shadowless)');
    expect([ownNumber('TG10/TG30'), ownNumber('074/131'), ownNumber('4'), ownNumber('SWSH050')]).toEqual(['tg10', '74', '4', 'swsh50']);
    expect(productName('Pikachu - 173/165')).toEqual({ base: 'Pikachu', variant: '' });
    expect(productName('Eevee (Poke Ball Pattern)')).toEqual({ base: 'Eevee', variant: 'Poke Ball Pattern' });
    expect(productName('Charizard ex - 199/165')).toEqual({ base: 'Charizard ex', variant: '' });
  });

  it("matches a plain card to the plain product and a pattern to its own, never another's", () => {
    expect([variantFits('', ''), variantFits('Reverse Holo', ''), variantFits('Holo', '')]).toEqual([true, true, true]);
    expect([variantFits('Poke Ball', 'Poke Ball Pattern'), variantFits('Master Ball', 'Master Ball Pattern'), variantFits('Poké Ball Reverse', 'Poke Ball Pattern')]).toEqual([true, true, true]);
    expect([variantFits('', 'Poke Ball Pattern'), variantFits('Master Ball', 'Poke Ball Pattern'), variantFits('Poke Ball', '')]).toEqual([false, false, false]);
    const eevee = (variant: string) => chooseProduct(prismatic, { name: 'Eevee', number: '074/131', variant })?.productId;
    expect([eevee(''), eevee('Reverse Holo'), eevee('Poke Ball'), eevee('Master Ball Pattern')]).toEqual([610429, 610429, 610590, 610691]);
    // Another number, or another name, isn't the card.
    expect(chooseProduct(prismatic, { name: 'Eevee', number: '075/131' })).toBeNull();
    expect(chooseProduct(tg, { name: 'Snorlax', number: 'TG10/TG30' })?.productId).toBe(284270);
    expect(chooseProduct(tg, { name: 'Pikachu', number: 'TG10/TG30' })).toBeNull();
    // A product the databases or the person named is taken by its id.
    expect(chooseProduct(tg, { name: 'whatever' }, '284270')?.productId).toBe(284270);
  });

  it("finds the card's set by name, TCGdex's name or code, then by sets that start or end with it", () => {
    const names = (c: Parameters<typeof candidateGroups>[1]) => candidateGroups(groups, c).map((t) => t.map((g) => g.name));
    expect(names({ set: 'Lost Origin Trainer Gallery' })).toEqual([['SWSH11: Lost Origin Trainer Gallery']]);
    // "Lost Origin" for a Trainer Gallery card: the set itself first, then its Trainer Gallery.
    expect(names({ set: 'Lost Origin' })).toEqual([['SWSH11: Lost Origin'], ['SWSH11: Lost Origin Trainer Gallery']]);
    expect(names({ set: '151' })).toEqual([['SV: Scarlet & Violet 151']]);
    expect(names({ set: 'Pokemon 151', setCode: 'MEW' })).toEqual([['SV: Scarlet & Violet 151']]);
    expect(names({ set: 'Base Set' })[0]).toEqual(['Base Set']);
    expect(names({ set: '' })).toEqual([]);
  });

  it("prices the card's printing, a regular common never at its reverse holo's price", () => {
    const lapras = fixture<TcgPrice[]>('23237-prices.json');
    expect(tcgPrice(lapras, 516694, printingOf('Reverse Holo', 'Uncommon'), false)).toBe(lapras.find((p) => p.productId === 516694 && p.subTypeName === 'Reverse Holofoil')!.marketPrice);
    expect(tcgPrice(lapras, 516694, printingOf('', 'Uncommon'), false)).toBe(lapras.find((p) => p.productId === 516694 && p.subTypeName === 'Normal')!.marketPrice);
    // A Trainer Gallery card is only a holofoil; a pattern is listed as one.
    expect(tcgPrice(tgPrices, 284270, printingOf('', 'Rare'), false)).toBe(tgPrices.find((p) => p.productId === 284270)!.marketPrice);
    expect(tcgPrice(prismaticPrices, 610590, printingOf('Poke Ball', 'Common'), true)).toBe(prismaticPrices.find((p) => p.productId === 610590)!.marketPrice);
  });

  it('downloads the list of sets and each set at most once a day, and gives up for the update after failing 3 times', async () => {
    const net = fakeTcgcsv();
    let now = new Date('2026-10-11T15:00:00Z');
    const t = new TcgCsv({ fetcher: net.fetcher, now: () => now, gapMs: 0 });
    const q = await t.quote({ name: 'Snorlax', set: 'Lost Origin Trainer Gallery', number: 'TG10/TG30', rarity: 'Rare' });
    expect(q).toEqual({
      productId: '284270',
      name: 'Snorlax',
      number: 'TG10/TG30',
      set: 'Lost Origin Trainer Gallery',
      url: 'https://www.tcgplayer.com/product/284270/pokemon-swsh11-lost-origin-trainer-gallery-snorlax',
      usd: tgPrices.find((p) => p.productId === 284270)!.marketPrice,
      rarity: 'Ultra Rare',
      released: '2022-09-09',
    });
    await t.quote({ name: 'Charizard', set: 'Lost Origin Trainer Gallery', number: 'TG03/TG30' });
    expect(net.calls).toHaveLength(3); // groups, the set's products and prices
    now = new Date('2026-10-12T15:00:00Z');
    await t.quote({ name: 'Snorlax', set: 'Lost Origin Trainer Gallery', number: 'TG10/TG30' });
    expect(net.calls).toHaveLength(6);
    // Down: three failures, then not asked again until the next update.
    const down = fakeTcgcsv(true);
    const d = new TcgCsv({ fetcher: down.fetcher, gapMs: 0 });
    for (let i = 0; i < 3; i++) await expect(d.quote({ name: 'Snorlax', set: 'Lost Origin', number: 'TG10' })).rejects.toThrow('answered 500');
    // The reason a card lookup shows between updates too.
    await expect(d.quote({ name: 'Snorlax', set: 'Lost Origin', number: 'TG10' })).rejects.toThrow("Skipped: tcgcsv.com kept failing, so it isn't asked again until the next price update.");
    expect(down.calls).toHaveLength(3 * 2); // 2 tries each
    d.reset();
    await expect(d.quote({ name: 'Snorlax', set: 'Lost Origin', number: 'TG10' })).rejects.toThrow('answered 500');
  });
});
