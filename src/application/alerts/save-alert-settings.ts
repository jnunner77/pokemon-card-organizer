import { checkAlertSettings } from '#domain/admin/alerts.ts';
import type { InvalidSetting } from '#domain/admin/settings.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { testEmail } from './alert-email.ts';
import type { AlertDeps } from './deps.ts';
import type { AppPasswordNeeded, MailFailedError, MailRefusedError } from './errors.ts';
import { MailRefused } from './ports.ts';
import { type AlertSettingsView, ReadAlertSettings } from './read-alert-settings.ts';
import { watching } from './watching.ts';

/**
 * Save the Gmail account alerts are sent from and who they go to, once a test email has gone out
 * with them: an address and app password Gmail refuses aren't saved. Without a new app password
 * the saved one is used.
 */
export class SaveAlertSettings {
  readonly #deps: AlertDeps;

  constructor(deps: AlertDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string; readonly body: unknown }): Promise<Result<AlertSettingsView, InvalidSetting | AppPasswordNeeded | MailRefusedError | MailFailedError>> {
    const d = this.#deps;
    const checked = checkAlertSettings(input.body);
    if (!checked.ok) return checked;
    const { settings } = checked.value;
    const password = checked.value.password ?? d.password.read();
    if (!password) return err({ code: 'APP_PASSWORD_NEEDED' });
    try {
      await d.mailer.send({ address: settings.gmail, password }, testEmail(settings.to, settings.link, await watching(d.ledger)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(error instanceof MailRefused ? { code: 'MAIL_REFUSED', message } : { code: 'MAIL_FAILED', message });
    }
    if (checked.value.password) d.password.write(password);
    d.settings.set({ alerts: settings });
    d.history.clearError();
    d.log.info('admin', `${input.actor} set up price alert emails from ${settings.gmail} to ${settings.to.join(', ')}`);
    return ok(await new ReadAlertSettings(d).execute());
  }
}
