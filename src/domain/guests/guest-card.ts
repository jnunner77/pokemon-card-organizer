import { cardValue } from '../cards/value.ts';

// What guests see of a card listed for sale: its details, market value (rounded up to the dollar)
// (or the price the owner set for guests) and picture; never what was paid, sales, notes, owner, binder location or price logs.

/** A card as the ledger keeps it. */
export type CardRecord = Readonly<Record<string, unknown>> & { readonly id: string };
type PriceRecord = Readonly<Record<string, unknown>>;

/** The page's condition adjustment: a near-mint price as the price of a card in this condition. */
export type ConditionAdjust = (card: CardRecord, price: PriceRecord) => number | null;

/** The card details guests see, as stored. */
const GUEST_DETAILS = ['name', 'set', 'setCode', 'number', 'rarity', 'variant', 'language', 'condition', 'grader', 'grade', 'artist', 'released'] as const;
type Detail = (typeof GUEST_DETAILS)[number];

export type GuestCard = { readonly id: string } & { readonly [K in Detail]: string | null } & {
  /** The price the owner set for guests, to the cent, else the market value in CAD rounded up to the dollar. */
  readonly value: number | null;
  /** The picture's address, or null without one. Changes when the picture does. */
  readonly image: string | null;
};

export const isListed = (card: CardRecord): boolean => card['status'] === 'listed' && !card['placeholder'];

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The picture the ledger shows for a card: the official one unless the person picked their own photo. */
export function shownImage(card: CardRecord): string | null {
  const official = text(card['officialImageId']);
  const photo = text(card['imageId']);
  return official && (card['imagePref'] !== 'photo' || !photo) ? official : photo;
}

/** The price the owner set for guests in CAD, to the cent; null when none is set. */
export function setGuestPrice(card: CardRecord): number | null {
  const v = card['guestPrice'];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

/** What guests see as a card's price: the price set for guests, else its market value in CAD as the page works it out (latest market price or sold comp, condition-adjusted), rounded up to the dollar. */
export function guestValue(card: CardRecord, usdToCad: number, adjust: ConditionAdjust): number | null {
  const set = setGuestPrice(card);
  if (set !== null) return set;
  const cad = cardValue(card, usdToCad, adjust);
  if (cad === null) return null;
  // To the cent first, so 21.000000001 stays $21.
  return Math.ceil(Math.round(cad * 100) / 100);
}

/** What a guest sees of a card. `version` names a picture, so its address changes when the picture does. */
export function guestCard(card: CardRecord, usdToCad: number, adjust: ConditionAdjust, version: (image: string) => string): GuestCard {
  const d = (field: Detail) => text(card[field]);
  const img = shownImage(card);
  return {
    id: card.id,
    name: d('name'),
    set: d('set'),
    setCode: d('setCode'),
    number: d('number'),
    rarity: d('rarity'),
    variant: d('variant'),
    language: d('language'),
    condition: d('condition'),
    grader: d('grader'),
    grade: d('grade'),
    artist: d('artist'),
    released: d('released'),
    value: guestValue(card, usdToCad, adjust),
    image: img ? `api/guest/cards/${encodeURIComponent(card.id)}/image?v=${version(img)}` : null,
  };
}
