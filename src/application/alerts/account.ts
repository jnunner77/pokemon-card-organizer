import type { AlertSettings } from '#domain/admin/alerts.ts';
import type { AlertDeps } from './deps.ts';
import type { MailAccount } from './ports.ts';

/** The saved Gmail account and where alerts go, or null until both the settings and the app password are saved. */
export function alertAccount(deps: Pick<AlertDeps, 'settings' | 'password'>): { readonly settings: AlertSettings; readonly mail: MailAccount } | null {
  const settings = deps.settings.get().alerts ?? null;
  const password = deps.password.read();
  if (!settings || !password) return null;
  return { settings, mail: { address: settings.gmail, password } };
}
