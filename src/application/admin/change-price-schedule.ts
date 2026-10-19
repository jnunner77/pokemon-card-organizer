import { checkPricingSchedule, type InvalidSetting } from '#domain/admin/settings.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AdminDeps } from './deps.ts';
import type { PriceUpdateSchedule } from './ports.ts';

/** Turn the daily price update on or off, change its hour, or whether Cardmarket is compared. */
export class ChangePriceSchedule {
  readonly #deps: Pick<AdminDeps, 'settings' | 'prices' | 'log'>;

  constructor(deps: Pick<AdminDeps, 'settings' | 'prices' | 'log'>) {
    this.#deps = deps;
  }

  execute(input: { readonly actor: string; readonly schedule: unknown }): Result<{ readonly schedule: PriceUpdateSchedule | Readonly<Record<string, unknown>> }, InvalidSetting> {
    const sent = checkPricingSchedule(input.schedule);
    if (!sent.ok) return sent;
    const pricing = { ...this.#deps.settings.get().pricing, ...sent.value };
    this.#deps.settings.set({ pricing });
    this.#deps.log.info('admin', `${input.actor} changed the price update schedule`, { ...pricing });
    return ok({ schedule: this.#deps.prices?.schedule() ?? { ...pricing } });
  }
}
