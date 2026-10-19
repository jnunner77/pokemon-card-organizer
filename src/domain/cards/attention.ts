import { isRecord } from '../ledger/document.ts';

// Cards that need a person: details that look wrong, no certain price match, a matched product
// without a price, or price sources that disagree. The same rules as Cards to check in the page
// (public/app.js, cardChecks), listed in status.txt for the server's nightly job.

/**
 * Which checks a card details lookup made. Bumped when lookups record something new, so cards
 * looked up before are looked up again once. 3: reprint sub-sets and the card's own set preferred,
 * TCG Pocket left out (an automatic match from before is looked up again; one the person chose stays).
 */
export const DETAILS_VERSION = 3;

/** What a price site says when it has the product but no price for the card's printing. */
export const NO_PRICE = 'has no price for this printing';

/** The card as named and numbered; Ignore in Cards to check holds until either changes. */
export const checkIdentity = (c: { readonly name?: unknown; readonly number?: unknown }): string =>
  `${String(c.name ?? '').trim().toLowerCase()}|${String(c.number ?? '').replace(/\s+/g, '').toLowerCase()}`;

type Card = Readonly<Record<string, unknown>>;

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The card is linked to a product on a price site, which then fills its set and release date. */
export function pricedFromProduct(c: Card): boolean {
  const p = c['pricing'];
  return isRecord(p) && (p['source'] === 'pricecharting' || p['source'] === 'tcgplayer') && !!p['id'];
}

/** What's wrong with a card's details, as found by its last lookup, or null. */
export function detailsProblem(c: Card): string | null {
  const d = c['details'];
  if (!isRecord(d) || d['v'] !== DETAILS_VERSION || c['checksIgnored'] === checkIdentity(c)) return null;
  const filed = d['filedUnder'];
  if (isRecord(filed) && norm(c['set']) === norm(filed['as'])) return `filed under ${String(filed['name'])}, but it's from ${String(d['set'])}.`;
  const suggest: readonly unknown[] = Array.isArray(d['suggest']) ? d['suggest'] : [];
  const first = suggest[0];
  if (d['result'] === 'notFound' && suggest.length) return `not in the card database. Did you mean ${String(isRecord(first) ? first['name'] : undefined)}?`;
  if (d['result'] === 'several') return 'several cards match. Choose yours.';
  // A price site that matched it (for certain, or as the person chose) confirms its name and number.
  if (d['result'] === 'notFound' && !pricedFromProduct(c)) return 'not in the card database (TCGdex). Check its name and number, or ignore it.';
  return null;
}

/** Most cards listed by name; the rest are counted. */
const MAX_LISTED = 10;

/**
 * Cards that need a person: details that look wrong (detailsProblem), the price search found no
 * certain match, or the card is matched to a product without a price. A search that failed
 * (site down) isn't one: the next run retries it.
 */
export function cardsNeedingAttention(cards: readonly Card[]): string[] {
  const out: string[] = [];
  for (const c of cards) {
    const label = [c['name'] || 'Unnamed card', c['setCode'] || c['set'], c['number']].filter(Boolean).join(' ');
    const problem = detailsProblem(c);
    if (problem) out.push(`${label}: ${problem} Open Cards to check in the binder.`);
    const p = c['pricing'];
    if (c['status'] === 'sold' || c['status'] === 'traded' || !isRecord(p)) continue;
    const error = p['error'];
    if (p['source'] === 'none' && !error && Array.isArray(p['candidates'])) out.push(`${label}: no certain match. Open the card and choose the product.`);
    else if (typeof error === 'string' && error.includes(NO_PRICE)) out.push(`${label}: ${error}`);
    const dis = p['disagree'];
    const quotes = isRecord(dis) ? dis['quotes'] : undefined;
    if (isRecord(dis) && isRecord(quotes) && c['pricesDisagreeIgnored'] !== dis['sig'])
      out.push(`${label}: its price sources disagree (${Object.entries(quotes).map(([k, v]) => `${k} US$${Number(v).toFixed(2)}`).join(', ')}); one of its matches may be the wrong card. Open Cards to check in the binder.`);
  }
  if (out.length <= MAX_LISTED) return out;
  return [...out.slice(0, MAX_LISTED), `…and ${out.length - MAX_LISTED} more. Open Cards to check in the binder.`];
}
