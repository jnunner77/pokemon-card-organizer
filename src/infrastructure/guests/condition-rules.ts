import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import type { ConditionRules } from '#application/guests/ports.ts';
import type { CardRecord } from '#domain/guests/guest-card.ts';

// The page's own condition adjustment (public/condition.js), run here so guests see the value the
// ledger shows. Loaded once, on first use.

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/condition.js');

export class PageConditionRules implements ConditionRules {
  #adjust: ((card: CardRecord, price: Readonly<Record<string, unknown>>) => unknown) | null = null;

  adjust(card: CardRecord, price: Readonly<Record<string, unknown>>): number | null {
    const v = (this.#adjust ??= this.#load())(card, price);
    return typeof v === 'number' ? v : null;
  }

  #load(): (card: CardRecord, price: Readonly<Record<string, unknown>>) => unknown {
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox);
    const rules = sandbox.window['BinderCondition'];
    const fn: unknown = typeof rules === 'object' && rules !== null && 'adjust' in rules ? rules.adjust : undefined;
    if (typeof fn !== 'function') throw new Error('public/condition.js has no BinderCondition.adjust');
    return (card, price) => Reflect.apply(fn, rules, [card, price]);
  }
}
