import { err, ok, type Result } from '#shared/result.ts';
import { expected, isRecord, textProblem, unrecognized } from './input.ts';
import type { InvalidSetting } from './settings.ts';

// Price alert emails, sent through a Gmail account with an app password (Google Account →
// Security → 2-Step Verification → App passwords: 16 letters, shown in groups of four). The
// address, who the alerts go to and the binder's address (for links) are settings; the app
// password is a secret kept in a file of its own, never shown, logged or returned.

/** Where price alerts come from and go to. */
export interface AlertSettings {
  /** The Gmail address that signs in and sends them. */
  readonly gmail: string;
  /** Who gets them (the Gmail address itself when none are given). */
  readonly to: readonly string[];
  /** The binder's own address, for links in the emails ("https://binder.example.com"); blank for none. */
  readonly link: string;
}

/** What an administrator sent: the settings, and a new app password (null: keep the saved one). */
export interface AlertSettingsInput {
  readonly settings: AlertSettings;
  readonly password: string | null;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const APP_PASSWORD = /^[a-z]{16}$/i;
const MAX_RECIPIENTS = 5;

export const NOT_AN_APP_PASSWORD = "That isn't a Google app password: it's 16 letters (spaces don't matter). Make one under Google Account → Security → 2-Step Verification → App passwords.";

const invalid = (message: string) => err<InvalidSetting>({ code: 'INVALID_SETTING', message });

export const isEmail = (s: string): boolean => s.length <= 254 && EMAIL.test(s);

const SITE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[^\s?#<>"']*)?$/i;

/** The binder's address without a trailing slash (or "" for none), or null when it isn't a web address. */
function siteLink(s: string): string | null {
  if (!s) return '';
  return s.length <= 300 && SITE.test(s) ? s.replace(/\/+$/, '') : null;
}

/** The alert settings as an administrator sent them: { gmail, to?, link?, password? }. */
export function checkAlertSettings(input: unknown): Result<AlertSettingsInput, InvalidSetting> {
  if (!isRecord(input)) return invalid(expected('object', input));
  const extra = unrecognized(input, ['gmail', 'to', 'link', 'password']);
  if (extra) return invalid(extra);
  const { gmail, to, link, password } = input;
  const gmailProblem = textProblem(gmail, { max: 254 });
  if (gmailProblem || typeof gmail !== 'string') return invalid(gmailProblem ?? 'Give the Gmail address.');
  const from = gmail.trim().toLowerCase();
  if (!isEmail(from)) return invalid(`“${gmail.trim()}” isn't an email address.`);
  if (to !== undefined && to !== null && typeof to !== 'string') return invalid(expected('string', to));
  const recipients = (typeof to === 'string' ? to : '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const wrong = recipients.find((r) => !isEmail(r));
  if (wrong) return invalid(`“${wrong}” isn't an email address.`);
  if (recipients.length > MAX_RECIPIENTS) return invalid(`Send alerts to at most ${MAX_RECIPIENTS} addresses.`);
  if (link !== undefined && link !== null && typeof link !== 'string') return invalid(expected('string', link));
  const site = siteLink(typeof link === 'string' ? link.trim() : '');
  if (site === null) return invalid("The binder's address should be a web address, like https://binder.example.com.");
  let secret: string | null = null;
  if (password !== undefined && password !== null && password !== '') {
    if (typeof password !== 'string') return invalid(expected('string', password));
    const compact = password.replace(/\s+/g, '');
    if (!APP_PASSWORD.test(compact)) return invalid(NOT_AN_APP_PASSWORD);
    secret = compact.toLowerCase();
  }
  return ok({ settings: { gmail: from, to: [...new Set(recipients.length ? recipients : [from])], link: site }, password: secret });
}

/** Saved alert settings (admin.json), or null when they're missing or damaged. */
export function alertSettingsFrom(saved: unknown): AlertSettings | null {
  if (!isRecord(saved)) return null;
  const { gmail, to, link } = saved;
  if (typeof gmail !== 'string' || !isEmail(gmail)) return null;
  const list = Array.isArray(to) ? to.filter((t): t is string => typeof t === 'string' && isEmail(t)) : [];
  return { gmail, to: list.length ? list : [gmail], link: typeof link === 'string' ? (siteLink(link) ?? '') : '' };
}
