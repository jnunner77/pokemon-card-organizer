import { err, ok, type Result } from '#shared/result.ts';

// Who a guest is: the name and the phone number or email they give at the table.

export const MAX_GUEST_NAME = 80;
export const MAX_GUEST_CONTACT = 120;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ContactKind = 'email' | 'phone';

export interface Contact {
  readonly kind: ContactKind;
  /** How contacts are compared: an email in lower case, a phone number's digits. */
  readonly key: string;
  /** As the guest wrote it, tidied. */
  readonly display: string;
}

export type GuestDetailsError =
  | { readonly code: 'GUEST_NAME_MISSING' }
  | { readonly code: 'GUEST_NAME_TOO_LONG' }
  | { readonly code: 'GUEST_CONTACT_MISSING' }
  | { readonly code: 'GUEST_CONTACT_TOO_LONG' }
  | { readonly code: 'INVALID_EMAIL' }
  | { readonly code: 'NOT_PHONE_OR_EMAIL' }
  | { readonly code: 'INVALID_PHONE' };

/** "  Ash   KETCHUM " → "ash ketchum": how names are compared. */
export const nameKey = (s: string): string => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** The name as the guest gave it: spaces around it dropped, runs of spaces made one. */
export function readGuestName(raw: string): Result<string, GuestDetailsError> {
  const name = raw.trim();
  if (!name) return err({ code: 'GUEST_NAME_MISSING' });
  if (name.length > MAX_GUEST_NAME) return err({ code: 'GUEST_NAME_TOO_LONG' });
  return ok(name.replace(/\s+/g, ' '));
}

/** An email (lower case) or a phone number (its digits; a North American leading 1 dropped), or why it isn't one. */
export function parseContact(raw: string): Result<Contact, GuestDetailsError> {
  const s = raw.normalize('NFKC').trim();
  if (s.includes('@')) {
    if (!EMAIL.test(s)) return err({ code: 'INVALID_EMAIL' });
    return ok({ kind: 'email', key: s.toLowerCase(), display: s });
  }
  if (!/^[+\d\s().-]+$/.test(s)) return err({ code: 'NOT_PHONE_OR_EMAIL' });
  let digits = s.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length < 7 || digits.length > 15) return err({ code: 'INVALID_PHONE' });
  return ok({ kind: 'phone', key: digits, display: s.replace(/\s+/g, ' ') });
}

/** The contact as the guest typed it, present and not too long; parseContact then reads it. */
export function readContactText(raw: string): Result<string, GuestDetailsError> {
  const text = raw.trim();
  if (!text) return err({ code: 'GUEST_CONTACT_MISSING' });
  return text.length > MAX_GUEST_CONTACT ? err({ code: 'GUEST_CONTACT_TOO_LONG' }) : ok(text);
}
