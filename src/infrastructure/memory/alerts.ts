import type { AlertCheckRecord, AlertHistory, MailAccount, Mailer, MailMessage } from '#application/alerts/ports.ts';
import { MailRefused, MailUnavailable } from '#application/alerts/ports.ts';

// What the price alerts last sent, kept in memory (the server uses it too: it's only shown under
// Administration → Alerts, and the log keeps the rest), and a mailer for tests.

export class MemoryAlertHistory implements AlertHistory {
  #sent: AlertCheckRecord | null = null;
  #error: AlertCheckRecord | null = null;

  lastSent(): AlertCheckRecord | null {
    return this.#sent;
  }

  lastError(): AlertCheckRecord | null {
    return this.#error;
  }

  note(record: AlertCheckRecord): void {
    if (record.buy || record.sell) this.#sent = record;
    if (record.error) this.#error = record;
    else if (record.buy || record.sell) this.#error = null;
  }

  clearError(): void {
    this.#error = null;
  }
}

/** Keeps what it was asked to send; `refuse` makes it refuse the sign-in, `fail` fail outright. */
export class MemoryMailer implements Mailer {
  readonly sent: { account: MailAccount; message: MailMessage }[] = [];
  refuse = false;
  fail: string | null = null;
  /** Only messages whose subject starts with this fail (with `fail`). */
  failOnly: string | null = null;

  async send(account: MailAccount, message: MailMessage): Promise<void> {
    if (this.refuse) throw new MailRefused('535 Username and Password not accepted');
    if (this.fail !== null && (this.failOnly === null || message.subject.startsWith(this.failOnly))) throw new MailUnavailable(this.fail);
    this.sent.push({ account, message });
  }
}
