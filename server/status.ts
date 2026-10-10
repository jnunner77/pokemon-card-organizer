import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Check } from './checks';
import { DETAILS_VERSION, type DetailsStatus, checkIdentity } from './details';
import { NO_PRICE } from './pricing/updater';

// A plain-text status file for the server's nightly job (Boards' deploy/ops/nightly.sh), which
// reads it with `docker compose exec binder cat /data/status.txt` and alerts on it. One line each:
//   written <ISO time>
//   ok|warn|fail <check title>: <detail> [Fix: <what to do>]
//   attention <card>: <what a person needs to do>
// And the other way: the nightly job writes offsite.json after copying a backup off the server.

export const STATUS_FILE = 'status.txt';
export const OFFSITE_FILE = 'offsite.json';

/** Checks that depend on the request a person makes in the browser; meaningless in the file. */
const PER_REQUEST = new Set(['https', 'proxy']);

const offsiteSchema = z.object({ at: z.string().datetime(), where: z.string().min(1).max(300) });

/** The nightly job's last copy off the server, if it has made one. */
export function readOffsite(dataDir: string): { at: string; where: string } | null {
  try {
    return offsiteSchema.parse(JSON.parse(fs.readFileSync(path.join(dataDir, OFFSITE_FILE), 'utf8')));
  } catch {
    return null;
  }
}

interface CardLike {
  name?: unknown;
  set?: unknown;
  setCode?: unknown;
  number?: unknown;
  status?: unknown;
  pricing?: { source?: unknown; id?: unknown; error?: unknown; candidates?: unknown; disagree?: { quotes?: Record<string, number>; sig?: string } | null } | null;
  pricesDisagreeIgnored?: unknown;
  details?: Partial<DetailsStatus> | null;
  checksIgnored?: unknown;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export { checkIdentity };

/** The card is linked to a product on a price site, which then fills its set and release date. */
export const pricedFromProduct = (c: CardLike) => (c.pricing?.source === 'pricecharting' || c.pricing?.source === 'tcgplayer') && !!c.pricing.id;

/**
 * What's wrong with a card's details, as found by its last lookup (details.ts), or null. The
 * same rules as Cards to check in the page (public/app.js, cardChecks).
 */
export function detailsProblem(c: CardLike): string | null {
  const d = c.details;
  if (!d || d.v !== DETAILS_VERSION || c.checksIgnored === checkIdentity(c)) return null;
  if (d.filedUnder && norm(c.set) === norm(d.filedUnder.as)) return `filed under ${d.filedUnder.name}, but it's from ${d.set}.`;
  if (d.result === 'notFound' && d.suggest?.length) return `not in the card database. Did you mean ${d.suggest[0].name}?`;
  if (d.result === 'several') return 'several cards match. Choose yours.';
  // A price site that matched it (for certain, or as the person chose) confirms its name and number.
  if (d.result === 'notFound' && !pricedFromProduct(c)) return "not in the card database (TCGdex). Check its name and number, or ignore it.";
  return null;
}

/** Most cards listed by name; the rest are counted. */
const MAX_LISTED = 10;

/**
 * Cards that need a person: details that look wrong (detailsProblem), the price search found no
 * certain match, or the card is matched to a product without a price. A search that failed
 * (site down) isn't one: the next run retries it.
 */
export function cardsNeedingAttention(cards: CardLike[]): string[] {
  const out: string[] = [];
  for (const c of cards) {
    const label = [c.name || 'Unnamed card', c.setCode || c.set, c.number].filter(Boolean).join(' ');
    const problem = detailsProblem(c);
    if (problem) out.push(`${label}: ${problem} Open Cards to check in the binder.`);
    if (c.status === 'sold' || c.status === 'traded' || !c.pricing) continue;
    if (c.pricing.source === 'none' && !c.pricing.error && Array.isArray(c.pricing.candidates)) out.push(`${label}: no certain match. Open the card and choose the product.`);
    else if (typeof c.pricing.error === 'string' && c.pricing.error.includes(NO_PRICE)) out.push(`${label}: ${c.pricing.error}`);
    const dis = c.pricing.disagree;
    if (dis?.quotes && c.pricesDisagreeIgnored !== dis.sig) out.push(`${label}: its price sources disagree (${Object.entries(dis.quotes).map(([k, v]) => `${k} US$${Number(v).toFixed(2)}`).join(', ')}); one of its matches may be the wrong card. Open Cards to check in the binder.`);
  }
  if (out.length <= MAX_LISTED) return out;
  return [...out.slice(0, MAX_LISTED), `…and ${out.length - MAX_LISTED} more. Open Cards to check in the binder.`];
}

export function statusText(now: Date, checks: Check[], attention: string[]): string {
  const one = (s: string) => s.replace(/\s+/g, ' ').trim();
  const lines = [`written ${now.toISOString()}`];
  for (const c of checks) {
    if (PER_REQUEST.has(c.id)) continue;
    const level = c.status === 'fail' ? 'fail' : c.status === 'warn' ? 'warn' : 'ok';
    lines.push(one(`${level} ${c.title}: ${c.detail}${level !== 'ok' && c.fix ? ` Fix: ${c.fix}` : ''}`));
  }
  for (const a of attention) lines.push(one(`attention ${a}`));
  return `${lines.join('\n')}\n`;
}

export function writeStatus(dataDir: string, text: string) {
  const file = path.join(dataDir, STATUS_FILE);
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}
