// What TCGplayer's own catalog (tcgcsv.com, a free public copy of TCGplayer's catalog API) says:
// its Pokémon sets ("groups"), their products (cards and sealed products) and the products' prices
// by printing ("Normal", "Holofoil", "Reverse Holofoil"…).

export interface TcgGroup {
  readonly groupId: number;
  readonly name: string;
  readonly abbreviation?: string | null | undefined;
  readonly publishedOn?: string | null | undefined;
}

export interface TcgProduct {
  readonly productId: number;
  readonly name: string;
  readonly groupId: number;
  readonly url?: string | undefined;
  readonly imageUrl?: string | undefined;
  readonly extendedData?: readonly { readonly name: string; readonly value: string }[] | undefined;
}

export interface TcgPrice {
  readonly productId: number;
  readonly marketPrice?: number | null | undefined;
  readonly midPrice?: number | null | undefined;
  readonly subTypeName: string;
}

/** One set's products and their prices. */
export interface TcgGroupContents {
  readonly products: readonly TcgProduct[];
  readonly prices: readonly TcgPrice[];
}

/** "051/165" → "51", "TG10/TG30" → "tg10", "SWSH050" → "swsh50": the number on the card, however it's written. */
export const ownNumber = (s: unknown): string => {
  const n = (String(s ?? '').split('/')[0] ?? '').replace(/\s+/g, '').toLowerCase();
  const m = /^([a-z]*)0*(\d+)([a-z]*)$/.exec(n);
  return m ? `${m[1]}${m[2]}${m[3]}` : n;
};

/** "SWSH11: Lost Origin Trainer Gallery" → "Lost Origin Trainer Gallery"; "Base Set" stays. */
export const setName = (g: { readonly name: string }): string => g.name.replace(/^[A-Za-z]{1,6}\d{0,3}[a-z]?:\s*/, '').trim();

/** A product's own field ("Number", "Rarity"), or null. */
export const extended = (p: TcgProduct, name: string): string | null => p.extendedData?.find((e) => e.name === name)?.value ?? null;

/** A product's name without its number, and what its brackets say: "Eevee (Poke Ball Pattern)" → Eevee, "Poke Ball Pattern". */
export function productName(name: string): { base: string; variant: string } {
  let base = name.replace(/\s+-\s+[A-Za-z]*\d+[A-Za-z]*(?:\/[A-Za-z]*\d+[A-Za-z]*)?\s*$/, '');
  const variant = [...base.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2]).join(' ');
  base = base.replace(/\s*(\([^)]*\)|\[[^\]]*\])\s*/g, ' ').trim();
  return { base, variant };
}

/** A TCGplayer product's picture on TCGplayer's image server. */
export const tcgImage = (id: string | number, size: 200 | 1000): string => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_${size}x${size}.jpg`;

/** A TCGplayer product's page. */
export const tcgplayerUrl = (id: string | number): string => `https://www.tcgplayer.com/product/${id}`;
