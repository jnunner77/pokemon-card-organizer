import type { AlertSettings } from '#domain/admin/alerts.ts';
import type { TokenState } from '#domain/admin/pricecharting-token.ts';
import type { AlertDeps } from './deps.ts';
import type { AlertCheckRecord } from './ports.ts';
import { watching } from './watching.ts';

export interface AlertSettingsView {
  /** Where alerts come from and go to; null until they're set up. */
  readonly settings: AlertSettings | null;
  /** Whether an app password is saved, and when (never the password). */
  readonly password: TokenState;
  readonly watching: { readonly buy: number; readonly sell: number };
  readonly lastSent: AlertCheckRecord | null;
  readonly lastError: AlertCheckRecord | null;
}

/** Administration → Alerts: the Gmail account, who alerts go to, and what was last sent. */
export class ReadAlertSettings {
  readonly #deps: Pick<AlertDeps, 'settings' | 'password' | 'history' | 'ledger'>;

  constructor(deps: Pick<AlertDeps, 'settings' | 'password' | 'history' | 'ledger'>) {
    this.#deps = deps;
  }

  async execute(): Promise<AlertSettingsView> {
    const d = this.#deps;
    return { settings: d.settings.get().alerts ?? null, password: d.password.info(), watching: await watching(d.ledger), lastSent: d.history.lastSent(), lastError: d.history.lastError() };
  }
}
