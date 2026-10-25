import type { AlertDeps } from './deps.ts';
import { type AlertSettingsView, ReadAlertSettings } from './read-alert-settings.ts';

/** Turn price alert emails off: the settings and the app password are removed. Watches stay. */
export class RemoveAlertSettings {
  readonly #deps: Pick<AlertDeps, 'settings' | 'password' | 'history' | 'ledger' | 'log'>;

  constructor(deps: Pick<AlertDeps, 'settings' | 'password' | 'history' | 'ledger' | 'log'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string }): Promise<AlertSettingsView> {
    const d = this.#deps;
    d.settings.set({ alerts: null });
    d.password.clear();
    d.history.clearError();
    d.log.info('admin', `${input.actor} turned price alert emails off`);
    return new ReadAlertSettings(d).execute();
  }
}
