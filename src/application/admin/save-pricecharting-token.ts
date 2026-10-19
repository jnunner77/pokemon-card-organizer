import { checkTokenFormat, type TokenState } from '#domain/admin/pricecharting-token.ts';
import type { InvalidSetting } from '#domain/admin/settings.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { priceCharting, type PriceChartingDeps, type PriceChartingUnavailable, type TokenCheckFailed, type TokenRefused } from './pricecharting-access.ts';

/** Save PriceCharting's API token, once PriceCharting has accepted it. */
export class SavePriceChartingToken {
  readonly #deps: PriceChartingDeps;

  constructor(deps: PriceChartingDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly body: unknown }): Promise<Result<{ readonly pricecharting: TokenState }, PriceChartingUnavailable | InvalidSetting | TokenRefused | TokenCheckFailed>> {
    const pc = priceCharting(this.#deps);
    if (!pc) return err({ code: 'PRICECHARTING_UNAVAILABLE' });
    const token = checkTokenFormat(input.body);
    if (!token.ok) return token;
    // One call to PriceCharting with it first: a token it doesn't know isn't saved.
    const checked = await pc.account.check(token.value);
    if (checked.outcome === 'refused') return err({ code: 'TOKEN_REFUSED' });
    if (checked.outcome === 'failed') return err({ code: 'TOKEN_CHECK_FAILED', message: checked.message });
    pc.token.write(token.value);
    pc.prices.noteToken();
    this.#deps.log.info('admin', `${input.actor} saved the PriceCharting API token`);
    return ok({ pricecharting: pc.token.info() });
  }
}
