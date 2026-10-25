import type { WatchSide } from '#domain/cards/watch.ts';
import { isRecord } from '#domain/ledger/document.ts';
import type { MailMessage } from './ports.ts';

// The buy and sell alert emails: each lists every card that reached its price, with how far past
// it the card is and where to buy or sell it. Buy alerts are green, sell alerts amber, and their
// subjects start differently, so they're told apart at a glance and can be filtered.

type CardFields = Readonly<Record<string, unknown>>;

/** A card that reached its price, as an alert lists it. */
export interface AlertLine {
  readonly card: CardFields;
  readonly target: number;
  readonly price: number;
}

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const money = (n: number): string => cad.format(n);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const isWeb = (u: string): boolean => /^https?:\/\/[^\s<>"']+$/i.test(u);

const LOOK = {
  buy: { colour: '#1f7a4d', tag: 'Buy alert', heading: 'Time to buy', under: 'under', past: 'at or under' },
  sell: { colour: '#b8620b', tag: 'Sell alert', heading: 'Time to sell', under: 'over', past: 'at or over' },
} as const;

/** "Lapras" and what tells the copy apart: "30th Celebration · 131/128 · Reverse Holo · PSA 10". */
export function cardName(card: CardFields): string {
  return text(card['name']) || 'Unnamed card';
}

export function cardDetails(card: CardFields): string {
  const grader = text(card['grader']);
  const graded = grader && grader !== 'Raw' ? `${grader} ${text(card['grade'])}`.trim() : '';
  const condition = text(card['condition']);
  const language = text(card['language']);
  return [
    text(card['set']) || text(card['setCode']),
    text(card['number']),
    text(card['variant']),
    graded || (condition && condition !== 'Near Mint' ? condition : ''),
    language && language !== 'English' ? language : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Where to buy or sell it: its products on the price sites, and an eBay search. */
export function cardLinks(card: CardFields, side: WatchSide): { readonly label: string; readonly url: string }[] {
  const out: { label: string; url: string }[] = [];
  const add = (source: unknown, url: unknown) => {
    const u = text(url);
    if (!isWeb(u) || out.some((l) => l.url === u)) return;
    out.push({ label: source === 'pricecharting' ? 'PriceCharting' : 'TCGplayer', url: u });
  };
  const pricing = card['pricing'];
  if (isRecord(pricing)) {
    if (pricing['source'] === 'tcgplayer' || pricing['source'] === 'pricecharting') add(pricing['source'], pricing['url']);
    const pair = pricing['pair'];
    if (isRecord(pair)) add(pair['source'], pair['url']);
  }
  const query = encodeURIComponent([cardName(card), text(card['number']), text(card['variant'])].filter(Boolean).join(' '));
  out.push(side === 'buy' ? { label: 'eBay.ca listings', url: `https://www.ebay.ca/sch/i.html?_nkw=${query}` } : { label: 'eBay.ca sold', url: `https://www.ebay.ca/sch/i.html?_nkw=${query}&LH_Sold=1&LH_Complete=1` });
  return out;
}

/** How far past its price a card is: "$0.50 under", or "at your price". */
function pastBy(side: WatchSide, l: AlertLine): string {
  const gap = Math.round(Math.abs(l.price - l.target) * 100) / 100;
  return gap === 0 ? 'at your price' : `${money(gap)} ${LOOK[side].under}`;
}

/** Furthest past its price first (as a share of the price). */
const order = (side: WatchSide) => (a: AlertLine, b: AlertLine) => {
  const share = (l: AlertLine) => (side === 'buy' ? (l.target - l.price) / l.target : (l.price - l.target) / l.target);
  return share(b) - share(a) || cardName(a.card).localeCompare(cardName(b.card));
};

/** The buy or sell alert for these cards (at least one), to `to`; `link` is the binder's address or "". */
export function alertEmail(side: WatchSide, lines: readonly AlertLine[], to: readonly string[], link: string): MailMessage {
  const look = LOOK[side];
  const sorted = [...lines].sort(order(side));
  const [first] = sorted;
  const subject =
    sorted.length === 1 && first
      ? `${look.tag}: ${cardName(first.card)} at ${money(first.price)} (your price ${money(first.target)})`
      : `${look.tag}: ${sorted.length} cards ${look.past} your price`;
  const watchlist = link ? `${link}/#watchlist` : '';
  const intro = side === 'buy' ? `${sorted.length === 1 ? 'A card you’re watching is' : `${sorted.length} cards you’re watching are`} at or under the price you want to buy at.` : `${sorted.length === 1 ? 'A card you’re watching is' : `${sorted.length} cards you’re watching are`} at or over the price you want to sell at.`;
  const footer = 'You get one email when a card reaches your price, and another only if it moves back and reaches it again. To change a watch, open the card in the binder (or the Watchlist) and change Watch price.';

  const textLines = sorted.map((l) => {
    const links = cardLinks(l.card, side)
      .map((k) => `   ${k.label}: ${k.url}`)
      .join('\n');
    const details = cardDetails(l.card);
    return `• ${cardName(l.card)}${details ? ` (${details})` : ''}\n   ${money(l.price)}, your price ${money(l.target)}: ${pastBy(side, l)}\n${links}`;
  });
  const plain = [`${look.heading}`, '', intro, '', ...textLines, '', ...(watchlist ? [`Your watchlist: ${watchlist}`, ''] : []), footer, ''].join('\n');

  const rows = sorted
    .map((l) => {
      const details = cardDetails(l.card);
      const links = cardLinks(l.card, side)
        .map((k) => `<a href="${esc(k.url)}" style="color:${look.colour}">${esc(k.label)}</a>`)
        .join(' · ');
      return `<tr><td style="padding:12px 0;border-bottom:1px solid #e3e6ea;vertical-align:top">
<div style="font-weight:600;font-size:16px">${esc(cardName(l.card))}</div>
${details ? `<div style="color:#5b6670;font-size:13px">${esc(details)}</div>` : ''}
<div style="font-size:13px;margin-top:6px">${links}</div></td>
<td style="padding:12px 0 12px 16px;border-bottom:1px solid #e3e6ea;text-align:right;vertical-align:top;white-space:nowrap">
<div style="font-weight:700;font-size:18px;color:${look.colour}">${esc(money(l.price))}</div>
<div style="color:#5b6670;font-size:13px">your price ${esc(money(l.target))}</div>
<div style="color:#5b6670;font-size:13px">${esc(pastBy(side, l))}</div></td></tr>`;
    })
    .join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2329">
<div style="max-width:600px;margin:0 auto;padding:16px">
<div style="background:${look.colour};color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">${esc(look.tag)}</div>
<div style="font-size:22px;font-weight:700">${esc(look.heading)}</div></div>
<div style="background:#fff;padding:4px 20px 16px;border-radius:0 0 10px 10px">
<p style="margin:14px 0 4px">${esc(intro)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse">${rows}</table>
${watchlist ? `<p style="margin:16px 0 0"><a href="${esc(watchlist)}" style="display:inline-block;background:${look.colour};color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Open your watchlist</a></p>` : ''}
<p style="color:#5b6670;font-size:12px;margin:16px 0 0">${esc(footer)}</p>
</div></div></body></html>`;
  return { to, subject, text: plain, html };
}

/** The email sent when alerts are set up, and by Send test email. */
export function testEmail(to: readonly string[], link: string, watching: { readonly buy: number; readonly sell: number }): MailMessage {
  const count = (n: number, what: string) => `${n} card${n === 1 ? '' : 's'} to ${what}`;
  const line = `You’re watching ${count(watching.buy, 'buy')} and ${count(watching.sell, 'sell')}.`;
  const how = 'Buy alerts and sell alerts come as separate emails: “Buy alert: …” and “Sell alert: …”, after each price update.';
  const site = link ? `<p><a href="${esc(link)}/#watchlist">Open your watchlist</a></p>` : '';
  return {
    to,
    subject: 'Price alerts from your binder are working',
    text: `Price alerts from your binder are working.\n\n${line}\n${how}\n${link ? `\nYour watchlist: ${link}/#watchlist\n` : ''}`,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2329"><p><b>Price alerts from your binder are working.</b></p><p>${esc(line)}</p><p>${esc(how)}</p>${site}</body></html>`,
  };
}
