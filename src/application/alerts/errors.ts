// What can go wrong setting up price alert emails.

export type AlertsNotSetUp = { readonly code: 'ALERTS_NOT_SET_UP' };
export type AppPasswordNeeded = { readonly code: 'APP_PASSWORD_NEEDED' };
export type MailRefusedError = { readonly code: 'MAIL_REFUSED'; readonly message: string };
export type MailFailedError = { readonly code: 'MAIL_FAILED'; readonly message: string };
