import { nullish, number, type Shape } from '../ledger/rules.ts';

// settings/main holds the page's own settings; settings/pricing holds the daily update's status,
// written only by the server, so its shape is checked loosely.
export const SETTING_FIELDS: Shape = {
  usdToCad: nullish(number({ above: 0, max: 100 })),
};

/** Settings documents the page may write; the rest are the server's own. */
export const PAGE_SETTINGS: readonly string[] = ['main'];
export const pageMayWrite = (id: string): boolean => PAGE_SETTINGS.includes(id);
