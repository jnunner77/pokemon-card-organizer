import { err, ok, type Result } from '#shared/result.ts';
import { alertAccount } from './account.ts';
import { testEmail } from './alert-email.ts';
import type { AlertDeps } from './deps.ts';
import type { AlertsNotSetUp, MailFailedError, MailRefusedError } from './errors.ts';
import { MailRefused } from './ports.ts';
import { watching } from './watching.ts';

/** Send a test email with the saved settings, to who alerts go to. */
export class SendTestAlert {
  readonly #deps: Pick<AlertDeps, 'settings' | 'password' | 'mailer' | 'ledger' | 'log'>;

  constructor(deps: Pick<AlertDeps, 'settings' | 'password' | 'mailer' | 'ledger' | 'log'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly actor: string }): Promise<Result<{ readonly to: readonly string[] }, AlertsNotSetUp | MailRefusedError | MailFailedError>> {
    const d = this.#deps;
    const account = alertAccount(d);
    if (!account) return err({ code: 'ALERTS_NOT_SET_UP' });
    try {
      await d.mailer.send(account.mail, testEmail(account.settings.to, account.settings.link, await watching(d.ledger)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      d.log.warn('admin', `${input.actor} sent a test price alert, which failed: ${message}`);
      return err(error instanceof MailRefused ? { code: 'MAIL_REFUSED', message } : { code: 'MAIL_FAILED', message });
    }
    d.log.info('admin', `${input.actor} sent a test price alert to ${account.settings.to.join(', ')}`);
    return ok({ to: account.settings.to });
  }
}
