import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// How a card's daily price is worked out from its sources (public/blend.js): one script, run by
// the page and here, so the daily update, the history rebuild and the page's "Fix past daily
// prices" always agree.

export type PriceMethod = 'blend' | 'highest' | 'pricecharting';
export interface BlendSettings {
  method: PriceMethod;
  /** Shares (any scale) for pricecharting, tcgplayer and cardmarket. */
  weights: Record<'pricecharting' | 'tcgplayer' | 'cardmarket', number>;
  /** How far (%) from the anchor (PriceCharting, else TCGplayer) a source may be and still count. */
  tolerance: number;
}
export interface BlendResult {
  usd: number;
  /** The source's name, or "Blend" when more than one counted. */
  where: string;
  used: Partial<Record<string, number>>;
  out: string[];
  anchor: string;
  /** The working, for the price's note. */
  summary: string;
}
interface BlendApi {
  price(quotes: Partial<Record<string, number | null>>, opts?: Partial<BlendSettings> | null): BlendResult | null;
  settings(opts?: Partial<BlendSettings> | null): BlendSettings;
  METHODS: Record<PriceMethod, string>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
let api: BlendApi | null = null;

export function blend(): BlendApi {
  if (!api) {
    const sandbox = { window: {} as { BinderBlend?: BlendApi } };
    vm.runInNewContext(fs.readFileSync(path.join(here, '../public/blend.js'), 'utf8'), sandbox);
    api = sandbox.window.BinderBlend!;
  }
  return api;
}
