import type { Candidate } from './sources';

// Deciding which product on a price site is the card in the binder. A card is linked
// automatically only when exactly one English product has the same number, the same name
// and the same set (and the same variant, or none). Anything less certain is left for the
// person to pick from a short list, because a wrong match quietly gives a wrong value.

export interface CardForMatch {
  name?: string | null;
  set?: string | null;
  setCode?: string | null;
  number?: string | null;
  variant?: string | null;
}

export const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

/** "131/128" -> "131", "024" -> "24", "SWSH298" -> "swsh298". */
export const cardNumber = (n: unknown) => {
  const left = String(n ?? '').split('/')[0].trim().toLowerCase();
  return /^\d+$/.test(left) ? String(Number(left)) : left.replace(/^([a-z]+)0+(?=\d)/, '$1');
};

/**
 * Name as the sites write it: "Hisuian Zoroark V Star" and "Hisuian Zoroark VSTAR" are the
 * same card, and "Sleep! (Rocket's Secret Machine)" is listed as "Sleep!".
 */
const nameKey = (s: unknown) =>
  norm(String(s ?? '').replace(/\[[^\]]*\]|\([^)]*\)/g, ''))
    .replace(/vstar$|v star$/, 'vstar')
    .replace(/^basic(\w+)energy$/, '$1energy');

const bracket = (title: string) => (title.match(/\[([^\]]+)\]/)?.[1] ?? '').trim();

const OTHER_LANGUAGES = /japanese|chinese|korean|thai|indonesian|german|french|italian|spanish|portuguese/i;
const PROMO_CODES = new Set(['mep', 'svp', 'swshp', 'smp', 'xyp', 'bwp', 'pr']);

/** A set name's words, without TCGplayer's prefixes ("SV01: ", "ME: ") or words that say nothing about the set. */
const setWords = (s: unknown) => {
  const words = String(s ?? '')
    .replace(/^[A-Za-z]{1,4}\d*(\.\d+)?:\s*/, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !['pokemon', 'tcg', 'english', 'the'].includes(w));
  // "Scarlet & Violet Base Set" is "Scarlet & Violet", but "Base Set" is a set of its own.
  const rest = words.filter((w) => w !== 'base' && w !== 'set');
  return rest.length ? rest : words;
};
const setKey = (s: unknown) => setWords(s).join('');

/** Edit distance, for telling a typo ("Eelktross", "Venasaur") from a different card. */
function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const nearly = (a: string, b: string) => a === b || (a.length >= 5 && distance(a, b) <= (a.length >= 8 ? 2 : 1));

function setMatches(card: CardForMatch, candidateSet: string): number {
  const want = setKey(card.set);
  const got = setKey(candidateSet);
  if (!got) return 0;
  // Black Star promos are numbered with a letter prefix (SWSH298, SVP 85) whatever set they shipped with.
  const isPromo = /promo/i.test(card.set ?? '') || PROMO_CODES.has(norm(card.setCode)) || /^(swsh|svp|sm|xy|bw|hgss|dp|np|mep)\s*\d+$/i.test(String(card.number ?? '').trim());
  if (isPromo) return /promo/i.test(candidateSet) ? 2 : 0;
  if (!want) return 0;
  if (got === want || got === `${want}energy`) return 3;
  if (got.includes(want) || want.includes(got)) return 2;
  // Every word of one name in the other, allowing a typo: "McDonalds 2022" and
  // "McDonald's Promos 2022", "Classic: Venasaur" and "TCG Classic: Venusaur Deck".
  const [a, b] = [setWords(card.set), setWords(candidateSet)];
  const within = (x: string[], y: string[]) => x.every((w) => y.some((v) => nearly(w, v)));
  if (a.length && b.length && (within(a, b) || within(b, a))) return 2;
  return 0;
}

export interface MatchResult {
  /** The product to link, when the match is certain. */
  match: Candidate | null;
  /** Plausible products, best first, for the person to choose from. */
  candidates: Candidate[];
}

export function chooseMatch(card: CardForMatch, all: Candidate[]): MatchResult {
  const num = cardNumber(card.number);
  const name = nameKey(card.name);
  const variant = norm(card.variant);
  const scored = all
    .filter((c) => !OTHER_LANGUAGES.test(c.set) && !OTHER_LANGUAGES.test(c.title))
    .map((c) => {
      const numOk = !!num && cardNumber(c.number) === num;
      const n = nameKey(c.title);
      const nameScore = n === name || (!!name && nearly(name, n)) ? 2 : name && (n.includes(name) || name.includes(n)) ? 1 : 0;
      const setScore = setMatches(card, c.set);
      const br = norm(bracket(c.title));
      // No variant on the card: the plain product. A variant: a product whose bracket shares a word with it.
      const variantOk = variant ? !!br && (variant.includes(br) || br.includes(variant) || sharesWord(card.variant!, bracket(c.title))) : !br;
      return { c, numOk, nameScore, setScore, variantOk, score: (numOk ? 8 : 0) + nameScore * 2 + setScore + (variantOk ? 1 : 0) };
    })
    .filter((x) => x.numOk || x.nameScore > 0)
    .sort((a, b) => b.score - a.score);
  const certain = scored.filter((x) => x.numOk && x.nameScore === 2 && x.setScore >= 2 && x.variantOk);
  return { match: certain.length === 1 ? certain[0].c : null, candidates: scored.slice(0, 8).map((x) => x.c) };
}

function sharesWord(a: string, b: string) {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'pokemon'].includes(w)));
  const wb = words(b);
  return [...words(a)].some((w) => wb.has(w));
}

/** What to type into a site's search box for this card. */
export function searchQuery(card: CardForMatch) {
  const name = String(card.name ?? '')
    .replace(/\bV Star\b/i, 'VSTAR')
    .replace(/\bV Max\b/i, 'VMAX')
    .trim();
  return `${name} ${cardNumber(card.number)}`.trim();
}
