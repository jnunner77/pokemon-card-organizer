// Rarities as the card databases and price sites write them, in the ledger's own words.

const RARITIES: Readonly<Record<string, string>> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  'rare holo': 'Holo Rare',
  'holo rare': 'Holo Rare',
  'double rare': 'Double Rare',
  'ultra rare': 'Ultra Rare',
  'holo rare v': 'Ultra Rare',
  'holo rare vmax': 'Ultra Rare',
  'holo rare vstar': 'Ultra Rare',
  'rare holo v': 'Ultra Rare',
  'rare holo vmax': 'Ultra Rare',
  'rare holo vstar': 'Ultra Rare',
  'rare holo ex': 'Ultra Rare',
  'rare holo gx': 'Ultra Rare',
  'illustration rare': 'Illustration Rare',
  'special illustration rare': 'Special Illustration Rare',
  'hyper rare': 'Hyper Rare',
  'mega hyper rare': 'Mega Hyper Rare',
  'ace spec rare': 'ACE SPEC Rare',
  'shiny rare': 'Shiny Rare',
  'shiny ultra rare': 'Shiny Rare',
  'secret rare': 'Secret Rare',
  // Older names, as other price sites still write them
  'rare ultra': 'Ultra Rare',
  'rare secret': 'Secret Rare',
  'rare rainbow': 'Secret Rare',
  'rare shiny': 'Shiny Rare',
  'rare shiny gx': 'Shiny Rare',
  'rare ace': 'ACE SPEC Rare',
  promo: 'Promo',
};

/** "Rare Holo" → "Holo Rare", "amazing rare" → "Amazing Rare"; "None" or blank → null. */
export function mapRarity(r: unknown): string | null {
  const s = String(r ?? '').trim();
  if (!s || /^none$/i.test(s)) return null;
  return RARITIES[s.toLowerCase()] ?? s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
