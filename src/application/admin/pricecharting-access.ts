import type { AdminDeps } from './deps.ts';

export type PriceChartingUnavailable = { readonly code: 'PRICECHARTING_UNAVAILABLE' };
export type TokenRefused = { readonly code: 'TOKEN_REFUSED' };
export type TokenCheckFailed = { readonly code: 'TOKEN_CHECK_FAILED'; readonly message: string };

export type PriceChartingDeps = Pick<AdminDeps, 'pricecharting' | 'prices' | 'log'>;

/** PriceCharting's token and API, and the daily update that uses them; null when this server has neither. */
export function priceCharting(deps: PriceChartingDeps) {
  return deps.pricecharting && deps.prices ? { ...deps.pricecharting, prices: deps.prices } : null;
}
