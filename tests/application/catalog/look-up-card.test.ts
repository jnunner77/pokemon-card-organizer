import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LookUpCard } from '#application/catalog/look-up-card.ts';
import { matches, setUp } from './fixtures.ts';

/** The matches for a card, from the recorded TCGdex answers. */
async function lookUp(name: string, number: string, hints: { set?: string; setCode?: string } = {}, t = setUp()) {
  const r = await new LookUpCard(t.deps).execute({ name, number, ...hints });
  assert.ok(r.ok);
  return r.value.matches;
}

describe('looking up a card by name and number', () => {
  it('finds the one card with that name, number and set size', async () => {
    assert.deepEqual(await lookUp('Pikachu', '51/162'), [
      {
        id: 'sv05-051',
        setId: 'sv05',
        name: 'Pikachu',
        number: '051',
        set: 'Temporal Forces',
        setCode: 'TEF',
        total: 162,
        rarity: 'Common',
        artist: 'kodama',
        released: '2024-03-22',
        thumb: 'https://assets.tcgdex.net/en/sv/sv05/051/low.webp',
      },
    ]);
  });

  it('offers every match when the number alone is ambiguous, and narrows by a typed set code or set', async () => {
    assert.deepEqual((await lookUp('Pikachu', '51')).map((m) => m.setCode).sort(), ['30C', 'TEF']);
    assert.deepEqual((await lookUp('Pikachu', '51', { setCode: 'tef' })).map((m) => m.set), ['Temporal Forces']);
    assert.deepEqual((await lookUp('Pikachu', '51', { set: 'Pokemon Temporal Forces' })).map((m) => m.setCode), ['TEF']);
    // A set code that doesn't match anything doesn't hide the matches.
    assert.equal((await lookUp('Pikachu', '51', { setCode: 'XYZ' })).length, 2);
  });

  it('matches names however they are written', async () => {
    matches((await lookUp('Meowth EX', '62/88'))[0], { setCode: 'POR', rarity: 'Double Rare', artist: '5ban Graphics' });
    matches((await lookUp("N's Zekrom", '031'))[0], { setCode: 'MEP', total: null, rarity: 'Promo' });
    matches((await lookUp('Hole-Digging Shovel', '74/88'))[0], { set: 'Perfect Order', artist: 'Toyste Beach' });
    matches((await lookUp('Hisuian Zoroark V Star', 'SWSH298'))[0], { set: 'SWSH Black Star Promos', setCode: null });
    matches((await lookUp('Charizard V', '17/172'))[0], { setCode: 'BRS', rarity: 'Ultra Rare' });
  });

  it('finds names with accents, words in brackets, or an unusual spelling (by number)', async () => {
    matches((await lookUp('Pokedex', '87/102'))[0], { set: 'Base Set', setCode: 'BS', artist: 'Keiji Kinebuchi' });
    matches((await lookUp('Pokemon Center Lady', '105/106'))[0], { setCode: 'FLF', rarity: 'Ultra Rare' });
    matches((await lookUp("Sleep! (Rocket's Secret Machine)", '79/82'))[0], { set: 'Team Rocket', setCode: 'RO' });
    const t = setUp();
    matches((await lookUp('Poke-dex', '87/102', {}, t))[0], { id: 'base1-87' });
    assert.ok(t.database.asked.includes('/cards?localId=87'));
  });

  it('finds a reprint in the sub-set of the set the card is filed under', async () => {
    assert.deepEqual((await lookUp('Lugia', '149/147', { set: '30th Celebration' })).map((m) => m.id), ['30th-c-029']);
    assert.deepEqual((await lookUp('Lugia', '149/147')).map((m) => m.id), ['ecard2-149']);
  });

  it('never matches TCG Pocket’s digital cards', async () => {
    // Lugia 131 is Unbroken Bonds' and TCG Pocket's (B2-131): only the real card.
    assert.deepEqual((await lookUp('Lugia', '131')).map((m) => m.id), ['sm9-131']);
  });

  it('finds nothing for a card TCGdex does not have, or without a name or number', async () => {
    assert.deepEqual(await lookUp('Nidorina', '101'), []);
    assert.deepEqual(await lookUp('', '51'), []);
    assert.deepEqual(await lookUp('Pikachu', ''), []);
  });

  it("says when the card database didn't answer", async () => {
    const t = setUp();
    t.database.down = true;
    assert.deepEqual(await new LookUpCard(t.deps).execute({ name: 'Pikachu', number: '51' }), {
      ok: false,
      error: { code: 'CARD_DATABASE_UNAVAILABLE', message: "Couldn't reach api.tcgdex.net: getaddrinfo ENOTFOUND api.tcgdex.net" },
    });
  });
});
