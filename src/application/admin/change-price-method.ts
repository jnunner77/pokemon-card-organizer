import { checkPriceMethod, type InvalidSetting } from '#domain/admin/settings.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AdminDeps } from './deps.ts';
import type { PriceUpdateSchedule } from './ports.ts';

/** How a card's daily price is worked out: blended, the highest, or PriceCharting first. */
export class ChangePriceMethod {
  readonly #deps: Pick<AdminDeps, 'settings' | 'prices' | 'log'>;

  constructor(deps: Pick<AdminDeps, 'settings' | 'prices' | 'log'>) {
    this.#deps = deps;
  }

  execute(input: { readonly actor: string; readonly method: unknown }): Result<{ readonly schedule: PriceUpdateSchedule | null }, InvalidSetting> {
    const priceMethod = checkPriceMethod(input.method);
    if (!priceMethod.ok) return priceMethod;
    this.#deps.settings.set({ priceMethod: priceMethod.value });
    this.#deps.prices?.noteToken();
    this.#deps.log.info('admin', `${input.actor} changed how daily prices are worked out`, { ...priceMethod.value });
    return ok({ schedule: this.#deps.prices?.schedule() ?? null });
  }
}
