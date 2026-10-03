import { z } from 'zod';

// What the ledger stores. Documents are checked on every write so a bad request can't
// corrupt the file, but the checks are deliberately loose about extra fields: the page
// grew them over time (sale records, notes) and a restore must never drop data.

export const COLLECTIONS = ['binders', 'cards', 'settings'] as const;
export type Collection = (typeof COLLECTIONS)[number];
export type Doc = Record<string, unknown>;

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ids are letters, digits, - and _ (at most 64)');
export const collectionSchema = z.enum(COLLECTIONS);

/** Largest single document: room for a card with an inline photo and a long price log. */
export const MAX_DOC_BYTES = 400_000;

const text = (max: number) => z.string().max(max);
const optText = (max: number) => text(max).nullish();
const count = (max: number) => z.number().int().min(1).max(max);

const price = z.looseObject({
  id: optText(64),
  at: optText(40),
  type: text(20),
  amount: z.number().finite().min(0).max(100_000_000),
  currency: text(8),
  date: optText(40),
  where: optText(500),
  note: optText(2000),
  /** Added by the daily price update (these are the ones kept for 30 days). */
  auto: z.boolean().nullish(),
  /** The source's US-dollar price behind an automatic CAD entry. */
  usd: z.number().finite().nullish(),
});

/** Which product on a price site this card is, for the daily price and image update. */
const pricingLink = z.looseObject({
  /** none: no match yet (see candidates); off: the person turned automatic pricing off. */
  source: z.enum(['pricecharting', 'tcgplayer', 'none', 'off']),
  id: optText(300),
  url: optText(500),
  title: optText(300),
  set: optText(200),
  linkedBy: z.enum(['auto', 'user']).nullish(),
  linkedAt: optText(40),
  /** Where the official image came from, so a new match fetches a new one. */
  imageUrl: optText(500),
  checkedAt: optText(40),
  /** The last update's problem with this card, cleared when it next works. */
  error: optText(500),
  /** Possible products when no match was certain: {source, id, url, title, set, number, usd, thumb}. */
  candidates: z.array(z.looseObject({ source: text(20), id: text(300) })).max(16).nullish(),
});

const sale = z.looseObject({
  amount: z.number().finite().nullish(),
  currency: optText(8),
  soldCAD: z.number().finite().nullish(),
  cost: z.number().finite().nullish(),
  profit: z.number().finite().nullish(),
  basis: optText(20),
  date: optText(40),
  where: optText(500),
  at: optText(40),
  priceId: optText(64),
});

const card = z.looseObject({
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
  prices: z.array(price).max(2000).nullish(),
  // A stored photo's id, or (for photos saved while uploads weren't available) a small data: URL.
  imageId: z.string().max(200_000).nullish(),
  binderId: optText(64),
  page: count(100_000).nullish(),
  slot: count(64).nullish(),
  sale: sale.nullish(),
  pricing: pricingLink.nullish(),
  /** High-resolution card image downloaded from the price site. */
  officialImageId: optText(64),
  /** Which picture to show: the official image (default when there is one) or the person's photo. */
  imagePref: z.enum(['official', 'photo']).nullish(),
  createdAt: optText(40),
  updatedAt: optText(40),
});

const binder = z.looseObject({
  name: text(80),
  color: optText(40),
  pockets: z.number().int().min(1).max(64).nullish(),
  order: z.number().finite().nullish(),
  createdAt: optText(40),
});

const settings = z.looseObject({
  usdToCad: z.number().finite().positive().max(100).nullish(),
});
// settings/pricing holds the daily update's status ({running, done, total, lastRun...}); it is
// written only by the server, so its shape is checked loosely.

const SCHEMAS: Record<Collection, z.ZodType<Doc>> = { binders: binder, cards: card, settings };

export class InvalidDoc extends Error {}

export function validateDoc(collection: Collection, doc: unknown): Doc {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new InvalidDoc('A document must be a JSON object');
  const { id: _id, ...rest } = doc as Doc;
  if (JSON.stringify(rest).length > MAX_DOC_BYTES) throw new InvalidDoc('That document is too large');
  const r = SCHEMAS[collection].safeParse(rest);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new InvalidDoc(`${issue.path.join('.') || collection}: ${issue.message}`);
  }
  return r.data;
}
