// Where prices and card images come from.
//
// PriceCharting (https://www.pricecharting.com) is the main source: its "ungraded" price is
// what the card has recently sold for on eBay, it lists nearly every English card including
// promos and brand-new sets, and its largest image is the sharpest freely available scan.
// TCGplayer's market price (recent TCGplayer sales) is the fallback for cards PriceCharting
// doesn't have. Both are read the way their own web pages read them, so a change on their
// side can break a source; the daily run records failures instead of stopping.

export type Source = 'pricecharting' | 'tcgplayer';

export interface Candidate {
  source: Source;
  /** PriceCharting: the product page path ("/game/pokemon-30th-celebration/lapras-131"). TCGplayer: the product id. */
  id: string;
  url: string;
  /** Card name as the source shows it, with any variant in brackets: "Pikachu [Holo]". */
  title: string;
  set: string;
  number: string;
  usd: number | null;
  /** Small picture for choosing between candidates. */
  thumb: string | null;
}

export interface Quote {
  usd: number | null;
  /** Largest available image of the card. */
  image: string | null;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const UA = 'Mozilla/5.0 (compatible; PokemonBinderLedger/1.0; personal collection tracker)';
const TIMEOUT_MS = 20_000;

export class SourceError extends Error {}

/** fetch with a timeout, an honest user agent and one retry when the site is busy. */
export async function get(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetcher(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (attempt < 1) continue;
      throw new SourceError(`Couldn't reach ${new URL(url).host}: ${err instanceof Error ? err.message : err}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 1) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!res.ok) throw new SourceError(`${new URL(url).host} answered ${res.status}`);
    return res;
  }
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#43;/g, '+')
    .replace(/\s+/g, ' ')
    .trim();
const money = (s: string | undefined) => {
  const m = s?.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};
/** "Lapras #131" -> {name: "Lapras", number: "131"}; "Pikachu [Holo] #7" keeps the bracket in the name. */
const splitTitle = (t: string) => {
  const m = t.match(/^(.*?)\s*#\s*([A-Za-z0-9-]+)\s*$/);
  return m ? { name: m[1].trim(), number: m[2] } : { name: t, number: '' };
};

// ---- PriceCharting ----------------------------------------------------------------

const PC = 'https://www.pricecharting.com';
/** Image URLs come in sizes (60, 240, 1600); 1600 is the largest the site has. */
const pcImage = (src: string | undefined, size: number) => (src ? src.replace(/\/(\d+)\.jpg$/, `/${size}.jpg`) : null);

export function parsePriceChartingProduct(html: string, path: string): Candidate & Quote {
  const h1 = html.match(/<h1[^>]*id="product_name"[^>]*>([\s\S]*?)<\/h1>/);
  if (!h1) throw new SourceError('PriceCharting page has no product name (layout changed?)');
  const set = decode(h1[1].match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
  const { name, number } = splitTitle(decode(h1[1].replace(/<a[\s\S]*<\/a>/, '')));
  const usd = money(html.match(/id="used_price"[\s\S]*?<span class="price js-price">([\s\S]*?)<\/span>/)?.[1]);
  const img = html.match(/id="product_details"[\s\S]*?<img src='([^']+)'/)?.[1] ?? html.match(/<img[^>]+src=['"](https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[^'"]+)['"]/)?.[1];
  return { source: 'pricecharting', id: path, url: PC + path, title: name, set, number, usd, thumb: pcImage(img, 240), image: pcImage(img, 1600) };
}

export function parsePriceChartingSearch(html: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of html.matchAll(/<tr id="product-\d+"[\s\S]*?<\/tr>/g)) {
    const row = m[0];
    const link = row.match(/<td class="title">\s*<a href="https:\/\/www\.pricecharting\.com(\/game\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const set = decode(row.match(/<td class="console[^"]*">\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
    const { name, number } = splitTitle(decode(link[2]));
    const usd = money(row.match(/<td class="price numeric used_price">([\s\S]*?)<\/td>/)?.[1]);
    const thumb = pcImage(row.match(/<img class="photo"[^>]*src="([^"]+)"/)?.[1], 240);
    out.push({ source: 'pricecharting', id: link[1], url: PC + link[1], title: name, set, number, usd, thumb });
  }
  return out;
}

export async function searchPriceCharting(fetcher: Fetcher, query: string): Promise<Candidate[]> {
  const res = await get(fetcher, `${PC}/search-products?type=prices&q=${encodeURIComponent(query)}`, { redirect: 'follow' });
  const html = await res.text();
  // One exact hit goes straight to the product page.
  const path = new URL(res.url || PC).pathname;
  if (path.startsWith('/game/')) return [parsePriceChartingProduct(html, path)];
  return parsePriceChartingSearch(html);
}

export async function quotePriceCharting(fetcher: Fetcher, path: string): Promise<Quote> {
  if (!/^\/game\/[^/?#\s]+\/[^/?#\s]+$/.test(path)) throw new SourceError(`Not a PriceCharting product path: ${path}`);
  const res = await get(fetcher, PC + path);
  const p = parsePriceChartingProduct(await res.text(), path);
  return { usd: p.usd, image: p.image };
}

// ---- TCGplayer --------------------------------------------------------------------

const tcgImage = (id: string | number, size: 200 | 1000) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_${size}x${size}.jpg`;

interface TcgResult {
  productId: number;
  productName: string;
  setName: string;
  marketPrice: number | null;
  customAttributes?: { number?: string };
}

export function parseTcgplayerSearch(json: unknown): Candidate[] {
  const results = (json as { results?: { results?: TcgResult[] }[] })?.results?.[0]?.results ?? [];
  return results.map((r) => {
    const id = String(Math.trunc(Number(r.productId)));
    // "Lapras - 131/128" -> "Lapras"
    const title = r.productName.replace(/\s+-\s+[A-Za-z0-9/]+$/, '').trim();
    return {
      source: 'tcgplayer' as const,
      id,
      url: `https://www.tcgplayer.com/product/${id}`,
      title,
      set: r.setName,
      number: String(r.customAttributes?.number ?? '').split('/')[0],
      usd: typeof r.marketPrice === 'number' ? Math.round(r.marketPrice * 100) / 100 : null,
      thumb: tcgImage(id, 200),
    };
  });
}

export async function searchTcgplayer(fetcher: Fetcher, query: string): Promise<Candidate[]> {
  const body = {
    algorithm: 'sales_synonym_v2',
    from: 0,
    size: 24,
    filters: { term: { productLineName: ['pokemon'] }, range: {}, match: {} },
    listingSearch: { context: { cart: {} }, filters: { term: { sellerStatus: 'Live', channelId: 0 }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } } },
    context: { cart: {}, shippingCountry: 'CA' },
    settings: { useFuzzySearch: true, didYouMean: {} },
    sort: {},
  };
  const res = await get(fetcher, `https://mp-search-api.tcgplayer.com/v1/search/request?q=${encodeURIComponent(query)}&isList=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseTcgplayerSearch(await res.json());
}

/**
 * Market price for one printing: reverse holos and other foils are priced separately from the
 * regular card. Many rares only come as foil, so their foil price is used; `strict` (for
 * commons and uncommons, which have a plain version) never borrows the other printing's price.
 */
export function pickTcgPrice(points: unknown, foil: boolean, strict = false): number | null {
  const list = Array.isArray(points) ? (points as { printingType?: string; marketPrice?: number | null }[]) : [];
  const priced = list.filter((p) => typeof p.marketPrice === 'number');
  const want = priced.find((p) => (p.printingType === 'Foil') === foil) ?? (strict ? undefined : priced[0]);
  return want ? Math.round(want.marketPrice! * 100) / 100 : null;
}

export async function quoteTcgplayer(fetcher: Fetcher, id: string, foil: boolean, strict = false): Promise<Quote> {
  if (!/^\d{1,10}$/.test(id)) throw new SourceError(`Not a TCGplayer product id: ${id}`);
  const res = await get(fetcher, `https://mpapi.tcgplayer.com/v2/product/${id}/pricepoints`);
  return { usd: pickTcgPrice(await res.json(), foil, strict), image: tcgImage(id, 1000) };
}

// ---- Exchange rate ----------------------------------------------------------------

/** The Bank of Canada's daily USD to CAD rate (published each business day around 16:30 ET). */
export async function usdToCad(fetcher: Fetcher): Promise<{ rate: number; date: string }> {
  const res = await get(fetcher, 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1');
  const obs = ((await res.json()) as { observations?: { d: string; FXUSDCAD?: { v: string } }[] }).observations?.[0];
  const rate = Number(obs?.FXUSDCAD?.v);
  if (!obs || !(rate > 0.5 && rate < 5)) throw new SourceError('The Bank of Canada rate was missing or out of range');
  return { rate, date: obs.d };
}
