// Sending price alert emails, and what the last check sent (kept in memory).

/** The Gmail account alerts are sent from: its address and app password. */
export interface MailAccount {
  readonly address: string;
  readonly password: string;
}

export interface MailMessage {
  readonly to: readonly string[];
  readonly subject: string;
  /** The plain-text version. */
  readonly text: string;
  /** The HTML version, shown by most mail apps. */
  readonly html: string;
}

/** Gmail didn't accept the account's address and app password. */
export class MailRefused extends Error {}

/** The mail server couldn't be reached, or didn't take the message. */
export class MailUnavailable extends Error {}

/** Sends email. Rejects with MailRefused when the sign-in is refused, MailUnavailable otherwise. */
export interface Mailer {
  send(account: MailAccount, message: MailMessage): Promise<void>;
}

/** What a check of the price watches did. */
export interface AlertCheckRecord {
  readonly at: string;
  /** Cards in the buy and sell alerts sent (0: none sent for that side). */
  readonly buy: number;
  readonly sell: number;
  /** Why an alert couldn't be sent, or null. */
  readonly error: string | null;
}

/** The last checks that sent something or failed, in memory. */
export interface AlertHistory {
  lastSent(): AlertCheckRecord | null;
  lastError(): AlertCheckRecord | null;
  note(record: AlertCheckRecord): void;
  /** The settings changed: an earlier failure no longer applies. */
  clearError(): void;
}
