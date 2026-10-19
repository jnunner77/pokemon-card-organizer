import type { TokenState } from '#domain/admin/pricecharting-token.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { priceCharting, type PriceChartingDeps, type PriceChartingUnavailable } from './pricecharting-access.ts';

/** Remove PriceCharting's API token: it's no longer asked. */
export class RemovePriceChartingToken {
  readonly #deps: PriceChartingDeps;

  constructor(deps: PriceChartingDeps) {
    this.#deps = deps;
  }

  execute(input: { readonly actor: string }): Result<{ readonly pricecharting: TokenState }, PriceChartingUnavailable> {
    const pc = priceCharting(this.#deps);
    if (!pc) return err({ code: 'PRICECHARTING_UNAVAILABLE' });
    pc.token.clear();
    pc.account.forget();
    pc.prices.noteToken();
    this.#deps.log.info('admin', `${input.actor} removed the PriceCharting API token`);
    return ok({ pricecharting: pc.token.info() });
  }
}
