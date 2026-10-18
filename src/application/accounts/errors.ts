import type { LastAdmin } from '#domain/accounts/account-book.ts';
import type { TokenError } from '#domain/accounts/api-token.ts';
import type { WeakPassword } from '#domain/accounts/password.ts';
import type { PersonError } from '#domain/accounts/person.ts';
import type { InvalidSetting } from '#domain/accounts/settings.ts';

/** Why signing in, changing a password or setting up the first administrator didn't happen. */
export type SignInError =
  | { readonly code: 'WRONG_PASSWORD' }
  | { readonly code: 'LOCKED'; readonly minutes: number }
  | { readonly code: 'SAME_PASSWORD' }
  | { readonly code: 'ALREADY_SET_UP' }
  | { readonly code: 'WRONG_SETUP_CODE' };

export type AccountError = SignInError | PersonError | WeakPassword | LastAdmin | TokenError | InvalidSetting;
