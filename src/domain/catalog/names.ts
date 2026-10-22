// Comparing what a person typed about a card with what the card databases say: names however
// they're written (accents, punctuation, "V Star"), card numbers with or without their set size,
// and set labels with or without "Pokémon".

/** "Pokémon", "N's", "V Star" → "pokemon", "ns", "vstar": compares names however they're written. */
export const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** A name's words, without accents or punctuation: "Farfetch’d" → ["farfetch", "d"], "Mr. Mime" → ["mr", "mime"]. */
export const words = (s: unknown): string[] =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** The card's own number without leading zeros: "051" → "51", "51/162" → "51", "SWSH298" → "swsh298". */
export const ownNumber = (s: unknown): string => {
  const n = (String(s ?? '').split('/')[0] ?? '').replace(/\s+/g, '').toLowerCase();
  return /^\d+$/.test(n) ? String(Number(n)) : n;
};

/** The set size after the slash, if the person typed one: "51/162" → 162. */
export const setSize = (s: unknown): number | null => {
  const m = /\/\s*(\d+)\s*$/.exec(String(s ?? ''));
  return m ? Number(m[1]) : null;
};

/** "Sleep! (Rocket's Secret Machine)" → "Sleep!": what the card itself is called. */
export const withoutBrackets = (name: string): string => name.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();

/** TCGdex's search doesn't ignore accents, so these are searched as printed on the card. */
const ACCENTED: Readonly<Record<string, string>> = { pokemon: 'Pokémon', pokedex: 'Pokédex', flabebe: 'Flabébé' };

/** A word as TCGdex's search needs it: "pokemon" → "Pokémon". */
export const asPrinted = (word: string): string => ACCENTED[word.toLowerCase()] ?? word;

/**
 * The word to search TCGdex by: the longest word of the name, which avoids its punctuation
 * ("N's", "Hole-Digging"), and not "Pokémon" when there's another word ("Pokémon Center Lady").
 */
export const searchWord = (name: string): string => {
  const all = withoutBrackets(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(ex|gx|v|vmax|vstar|star|mega|lv|x)$/i.test(w));
  const pick = (all.length > 1 ? all.filter((w) => !/^pokemon$/i.test(w)) : all).reduce((a, b) => (b.length >= a.length ? b : a), '');
  return asPrinted(pick);
};

/** How alike two names are, 0 to 1, by edit distance: "Mega Eelktross EX" vs "Mega Eelektross ex" ≈ 0.94. */
export function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1);
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, sub);
    }
    prev = cur;
  }
  return 1 - (prev[y.length] ?? 0) / Math.max(x.length, y.length);
}

/** "Pokemon Base Set" → "Base Set": how a set label is searched on TCGdex. */
export const setLabel = (s: unknown): string =>
  String(s ?? '')
    .replace(/^\s*pok[eé]mon\s+/i, '')
    .trim();

/** "2026-03-27" or "1999/01/09" → "1999-01-09"; anything else → null. */
export const isoDate = (s: unknown): string | null => {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(String(s ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export const isBlank = (v: unknown): boolean => v == null || String(v).trim() === '';

/** The number on the card as price sites compare it: "131/128" → "131", "024" → "24", "SWSH050" → "swsh50". */
export const cardNumber = (n: unknown): string => {
  const left = (String(n ?? '').split('/')[0] ?? '').trim().toLowerCase();
  return /^\d+$/.test(left) ? String(Number(left)) : left.replace(/^([a-z]+)0+(?=\d)/, '$1');
};
