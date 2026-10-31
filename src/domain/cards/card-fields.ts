import { arrayOf, bool, cents, count, documentIdRule, loose, nullish, number, oneOf, optText, integer, someOf, text, type Shape } from '../ledger/rules.ts';

// The fields of a card the ledger knows about, and what each may hold. Anything else on a card is
// kept as it is (see ledger/document.ts).

/** Who a card or binder belongs to (Both: Megan and Justin); blank when not set. */
export const OWNERS = ['', 'Megan', 'Justin', 'Maiya', 'Both'] as const;
export type Owner = (typeof OWNERS)[number];

export const PRICE_SOURCES = ['pricecharting', 'tcgplayer', 'cardmarket', 'ebay'] as const;
/** Which product on a price site a card is: none (no match yet) or off (automatic pricing turned off). */
export const PRICING_SOURCES = ['pricecharting', 'tcgplayer', 'none', 'off'] as const;
export const PAIR_SOURCES = ['pricecharting', 'tcgplayer'] as const;
export const LINKED_BY = ['auto', 'user'] as const;
export const IMAGE_PREFS = ['official', 'photo'] as const;

export const MAX_PAGE = 100_000;
export const MAX_POCKETS = 64;

const price = loose({
  id: optText(64),
  at: optText(40),
  type: text(20),
  amount: number({ min: 0, max: 100_000_000 }),
  currency: text(8),
  date: optText(40),
  where: optText(500),
  note: optText(2000),
  /** Added by the daily price update (these are the ones kept for 30 days). */
  auto: nullish(bool),
  /** The source's US-dollar price behind an automatic CAD entry. */
  usd: nullish(number()),
  /** Each price source's US-dollar price behind it; `usd` is the highest. */
  quotes: nullish(someOf(PRICE_SOURCES, number())),
  /** A graded card's automatic price: the PriceCharting grade it is for ("PSA 10", "Grade 9"). */
  grade: optText(40),
});

const pair = loose({
  source: oneOf(PAIR_SOURCES),
  id: optText(300),
  url: optText(500),
  title: optText(300),
  set: optText(200),
  linkedBy: nullish(oneOf(LINKED_BY)),
  linkedAt: optText(40),
  off: nullish(bool),
  checkedAt: optText(40),
  error: optText(500),
});

/** Which product on a price site this card is, for the daily price and image update. */
const pricing = loose({
  source: oneOf(PRICING_SOURCES),
  id: optText(300),
  url: optText(500),
  title: optText(300),
  set: optText(200),
  linkedBy: nullish(oneOf(LINKED_BY)),
  linkedAt: optText(40),
  /** Where the official image came from, so a new match fetches a new one. */
  imageUrl: optText(500),
  checkedAt: optText(40),
  /** The last update's problem with this card, cleared when it next works. */
  error: optText(500),
  /** Possible products when no match was certain. */
  candidates: nullish(arrayOf(loose({ source: text(20), id: text(300) }), 16)),
  /** The card's product on the other price site, whose price is compared with this one's. */
  pair: nullish(pair),
});

/** What a trade with a dealer was (ledger/trade.ts), kept on every card it touched. */
const tradeSummary = {
  id: documentIdRule,
  date: optText(40),
  gaveCash: nullish(number({ min: 0 })),
  gotCash: nullish(number({ min: 0 })),
  gave: nullish(integer(0, 500)),
  got: nullish(integer(0, 500)),
  with: optText(200),
};

const sale = loose({
  amount: nullish(number()),
  currency: optText(8),
  soldCAD: nullish(number()),
  cost: nullish(number()),
  profit: nullish(number()),
  basis: optText(20),
  date: optText(40),
  where: optText(500),
  at: optText(40),
  priceId: optText(64),
  /** Sold together with other cards for one price, split across them (public/sales.js). */
  bundle: nullish(loose({ id: text(64), total: number({ min: 0 }), currency: optText(8), count: integer(1, 500), split: optText(20) })),
  /** Traded away to a dealer (public/trade.js): the trade, with what each side gave. */
  trade: nullish(loose(tradeSummary)),
});

/** Came in a trade (ledger/trade.ts): a new card, or a placeholder it filled and what it was before. */
const trade = loose({
  ...tradeSummary,
  filled: nullish(bool),
  was: nullish(loose({ grader: optText(20), grade: optText(20) })),
  entryIds: nullish(arrayOf(text(64), 20)),
});

/** Price watches the person set, in CAD (cards/watch.ts). */
const watch = loose({
  /** Email when the card's value is at or below this. */
  buy: nullish(cents(100_000_000)),
  /** Email when the card's value is at or above this (only for a card the person has). */
  sell: nullish(number({ above: 0, max: 100_000_000 })),
});
const watchAlert = loose({ at: text(40), target: number(), price: number() });

const details = loose({
  source: text(20),
  result: text(20),
  id: optText(100),
  filled: nullish(arrayOf(text(20), 8)),
  released: optText(10),
  error: optText(300),
  checkedAt: optText(40),
});

export const CARD_FIELDS: Shape = {
  name: optText(200),
  set: optText(200),
  setCode: optText(40),
  number: optText(40),
  rarity: optText(100),
  variant: optText(200),
  language: optText(60),
  condition: optText(60),
  grader: optText(20),
  grade: optText(20),
  artist: optText(200),
  notes: optText(10_000),
  status: optText(20),
  owner: nullish(oneOf(OWNERS)),
  prices: nullish(arrayOf(price, 2000)),
  // A stored photo's id, or (for photos saved while uploads weren't available) a small data: URL.
  imageId: optText(200_000),
  binderId: optText(64),
  page: nullish(count(MAX_PAGE)),
  slot: nullish(count(MAX_POCKETS)),
  sale: nullish(sale),
  trade: nullish(trade),
  pricing: nullish(pricing),
  /** Holds its pocket for a card the person doesn't have yet: priced, but left out of totals. */
  placeholder: nullish(bool),
  /** Only on the watchlist: a card the person doesn't have and is watching to buy, in no binder. */
  watchlist: nullish(bool),
  watch: nullish(watch),
  /** The watches emailed, kept until the value moves back past them (written by the server). */
  watchAlerts: nullish(loose({ buy: nullish(watchAlert), sell: nullish(watchAlert) })),
  /** The price guests see instead of the market value, in CAD (blank: the market value). */
  guestPrice: nullish(number({ above: 0, max: 100_000_000 })),
  /** Cards to check: the card's name and number when the person chose to ignore its problem. */
  checksIgnored: optText(300),
  /** Cards to check: the person said the card's disagreeing prices are right, for these matches. */
  pricesDisagreeIgnored: optText(700),
  /** When the card's set came out, YYYY-MM-DD, from TCGdex. */
  released: optText(10),
  /** The last TCGdex lookup of the card's set, set code, rarity, illustrator and release date. */
  details: nullish(details),
  /** High-resolution card image downloaded from the price site. */
  officialImageId: optText(64),
  /** Which picture to show: the official image (default when there is one) or the person's photo. */
  imagePref: nullish(oneOf(IMAGE_PREFS)),
  createdAt: optText(40),
  updatedAt: optText(40),
};
