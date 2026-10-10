import fs from 'node:fs';

// The Administration overview: is this server ready for the public internet, and is it
// healthy? Each check says what it found and, when it isn't passing, what to do about it.

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';
export interface Check {
  id: string;
  group: 'Sign-in' | 'Connection' | 'Rate limiting' | 'Backups' | 'Logs' | 'Prices' | 'Server';
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface CheckInputs {
  now: Date;
  /** Whether this request reached the app over HTTPS (as reported by a trusted proxy). */
  secure: boolean;
  /** A proxy sent X-Forwarded-For but the app isn't told to trust it. */
  untrustedProxy: boolean;
  localRequest: boolean;
  authEnabled: boolean;
  accounts: { users: number; admins: number; adminsMustChange: number; settings: { passwordMinLength: number; lockoutAfter: number; sessionMaxDays: number }; sessions: number; tokens: number; tokensExpired: number; tokensStale: number; setupPending: boolean } | null;
  envPasswordStillWorks: boolean;
  security: { enabled: boolean; bans: number; limited: number; blocked: number; allowlist: number } ;
  failedSignIns24h: number;
  backups: { newestDaily: string | null; dailyCopies: number; snapshots: number; retention: { daily: number; weekly: number; monthly: number } };
  lastFullBackupAt: string | null;
  /** The server's nightly job copied a backup off the server (offsite.json in the data directory). */
  offsite: { at: string; where: string } | null;
  logs: { fileOk: boolean | null; dir: string | undefined; errors24h: number; warnings24h: number };
  pricing: { enabled: boolean; hour: number; timeZone: string; lastRun: { date: string; finishedAt: string; counts: Record<string, number> } | null; running: boolean; rateDate: string | null; problem?: { title: string; message: string; recoveredAt?: string | null } | null };
  disk: { freeBytes: number | null; dataBytes: number };
}

const hoursSince = (iso: string | null, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : Infinity);
const mb = (b: number) => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`;

export function runChecks(i: CheckInputs): Check[] {
  const c: Check[] = [];
  const add = (x: Check) => c.push(x);

  // ---- Sign-in
  add(
    i.authEnabled
      ? { id: 'auth', group: 'Sign-in', title: 'Sign-in required', status: 'pass', detail: 'Everyone must sign in; every page, picture and API call is refused without a session or API token.' }
      : { id: 'auth', group: 'Sign-in', title: 'Sign-in required', status: 'fail', detail: 'AUTH=off: anyone who can reach the server can read and change the ledger.', fix: 'Remove AUTH=off from the environment and restart. It is only for running on your own computer.' },
  );
  const a = i.accounts;
  if (a) {
    if (a.setupPending) add({ id: 'setup', group: 'Sign-in', title: 'First administrator', status: 'warn', detail: 'No accounts yet. Anyone holding the setup code from the server log can create the first administrator.', fix: 'Open the ledger now and create your administrator account.' });
    else add({ id: 'admins', group: 'Sign-in', title: 'Administrators', status: a.admins >= 1 ? (a.admins === 1 ? 'info' : 'pass') : 'fail', detail: `${a.admins} active administrator${a.admins === 1 ? '' : 's'}, ${a.users} active account${a.users === 1 ? '' : 's'} in all.${a.admins === 1 ? ' With only one, a forgotten password means editing auth.json on the server.' : ''}` });
    if (a.adminsMustChange) add({ id: 'admin-temp', group: 'Sign-in', title: 'Temporary administrator passwords', status: 'warn', detail: `${a.adminsMustChange} administrator${a.adminsMustChange === 1 ? ' has' : 's have'} not chosen their own password yet.` });
    add(
      a.settings.passwordMinLength >= 10
        ? { id: 'pw-length', group: 'Sign-in', title: 'Password rules', status: 'pass', detail: `At least ${a.settings.passwordMinLength} characters, not the username, not a common password; hashed with scrypt.` }
        : { id: 'pw-length', group: 'Sign-in', title: 'Password rules', status: 'warn', detail: `Passwords may be as short as ${a.settings.passwordMinLength} characters.`, fix: 'Raise the minimum to 10 or more under Sign-in settings.' },
    );
    add({ id: 'lockout', group: 'Sign-in', title: 'Wrong-password lockout', status: 'pass', detail: `After ${a.settings.lockoutAfter} wrong passwords a username is locked, for twice as long each time (up to a day).` });
    if (a.tokensExpired || a.tokensStale) add({ id: 'tokens', group: 'Sign-in', title: 'API tokens', status: 'warn', detail: `${a.tokensExpired} expired and ${a.tokensStale} unused for 90 days.`, fix: 'Revoke tokens nobody uses under API tokens.' });
  }
  if (i.envPasswordStillWorks) add({ id: 'env-password', group: 'Sign-in', title: 'Start-up password', status: 'warn', detail: 'The "admin" account still uses the password from BINDER_PASSWORD, which sits in plain text in .env on the server.', fix: 'Sign in as admin and set a new password under People (or create your own administrator and deactivate "admin"), then remove BINDER_PASSWORD from .env.' });
  add(
    i.failedSignIns24h > 50
      ? { id: 'failed-signins', group: 'Sign-in', title: 'Failed sign-ins (24 h)', status: 'warn', detail: `${i.failedSignIns24h} failed sign-ins. Someone may be guessing passwords; lockouts and blocks are working against it.`, fix: 'Check the Logs page (category auth) and the blocked addresses under Security.' }
      : { id: 'failed-signins', group: 'Sign-in', title: 'Failed sign-ins (24 h)', status: 'pass', detail: `${i.failedSignIns24h} failed sign-in${i.failedSignIns24h === 1 ? '' : 's'}.` },
  );

  // ---- Connection
  add(
    i.secure
      ? { id: 'https', group: 'Connection', title: 'HTTPS', status: 'pass', detail: 'This page arrived over HTTPS; sign-in cookies are marked Secure and HSTS is sent.' }
      : i.localRequest
        ? { id: 'https', group: 'Connection', title: 'HTTPS', status: 'info', detail: 'Plain HTTP from this computer. Fine for trying it out; on the internet it must be behind HTTPS.' }
        : { id: 'https', group: 'Connection', title: 'HTTPS', status: 'fail', detail: 'This page arrived over plain HTTP, so passwords and cookies cross the network unencrypted.', fix: 'Serve it through Caddy (deploy/README.md) and set TRUST_PROXY=1.' },
  );
  if (i.untrustedProxy) add({ id: 'proxy', group: 'Connection', title: 'Reverse proxy', status: 'fail', detail: 'Requests come through a proxy but TRUST_PROXY is not set, so every visitor looks like the proxy: rate limits and blocks would hit everyone at once.', fix: 'Set TRUST_PROXY=1 (docker-compose.yml already does).' });
  add({ id: 'headers', group: 'Connection', title: 'Browser protections', status: 'pass', detail: 'Strict Content Security Policy, no framing, nosniff, same-origin referrers; changes from other websites are refused; uploads are checked by their bytes.' });

  // ---- Rate limiting
  add(
    i.security.enabled
      ? { id: 'rate-limits', group: 'Rate limiting', title: 'Rate limits and blocks', status: 'pass', detail: `Limits per address and per person are on. Since the server started: ${i.security.limited} requests limited, ${i.security.blocked} addresses blocked (blocks double for repeat offenders, up to a day). ${i.security.bans} blocked right now.` }
      : { id: 'rate-limits', group: 'Rate limiting', title: 'Rate limits and blocks', status: 'fail', detail: 'Rate limiting is off.' },
  );
  if (i.security.allowlist) add({ id: 'allowlist', group: 'Rate limiting', title: 'Trusted addresses', status: 'info', detail: `${i.security.allowlist} address${i.security.allowlist === 1 ? '' : 'es'} in SECURITY_ALLOWLIST are never limited or blocked.` });

  // ---- Backups
  const age = hoursSince(i.backups.newestDaily, i.now);
  add(
    age < 48
      ? { id: 'daily-copy', group: 'Backups', title: 'Daily copies on the server', status: 'pass', detail: `Newest copy ${i.backups.newestDaily!.slice(0, 10)}; ${i.backups.dailyCopies} kept (newest ${i.backups.retention.daily} days, ${i.backups.retention.weekly} weeks, ${i.backups.retention.monthly} months), ${i.backups.snapshots} snapshot${i.backups.snapshots === 1 ? '' : 's'}.` }
      : { id: 'daily-copy', group: 'Backups', title: 'Daily copies on the server', status: 'fail', detail: i.backups.newestDaily ? `The newest daily copy is from ${i.backups.newestDaily.slice(0, 10)}.` : 'No daily copy yet.', fix: 'Take a snapshot under Backups now; check the Logs page (category backup) for errors.' },
  );
  const offAge = hoursSince(i.lastFullBackupAt, i.now) / 24;
  const autoAge = hoursSince(i.offsite?.at ?? null, i.now) / 24;
  const days = (d: number) => (d < 1 ? 'today' : `${Math.floor(d)} day${Math.floor(d) === 1 ? '' : 's'} ago`);
  if (autoAge <= 2) add({ id: 'offsite', group: 'Backups', title: 'Copy off the server', status: 'pass', detail: `The nightly job copied a backup to ${i.offsite!.where} ${days(autoAge)}.` });
  else if (i.offsite) add({ id: 'offsite', group: 'Backups', title: 'Copy off the server', status: 'warn', detail: `The nightly job last copied a backup off the server ${days(autoAge)}.${offAge <= 30 ? ` A full backup was downloaded ${days(offAge)}.` : ''}`, fix: 'Check the nightly job on the server: journalctl -u nunner-ops (Boards deploy/README.md, "Automatic operations").' });
  else
    add(
      offAge <= 30
        ? { id: 'offsite', group: 'Backups', title: 'Copy off the server', status: 'pass', detail: `A full backup (with photos) was downloaded ${days(offAge)}.` }
        : { id: 'offsite', group: 'Backups', title: 'Copy off the server', status: 'warn', detail: i.lastFullBackupAt ? `The last full backup was downloaded ${days(offAge)}.` : 'No full backup has been downloaded from here.', fix: 'Set up the nightly job that copies backups to Cloud Storage (Boards deploy/README.md, "Automatic operations"), or download a full backup under Backups now and then.' },
    );

  // ---- Logs
  add(
    i.logs.fileOk === false
      ? { id: 'log-files', group: 'Logs', title: 'Log files', status: 'fail', detail: `Can't write log files to ${i.logs.dir}.`, fix: 'Check the data volume has free space and belongs to the app user.' }
      : { id: 'log-files', group: 'Logs', title: 'Log files', status: i.logs.dir ? 'pass' : 'warn', detail: i.logs.dir ? 'Requests, sign-ins, administration, security and price-update events are logged to a file per day (kept two weeks) and shown on the Logs page.' : 'Logs only go to the console.' },
  );
  add(
    i.logs.errors24h
      ? { id: 'errors', group: 'Logs', title: 'Errors (24 h)', status: 'warn', detail: `${i.logs.errors24h} error${i.logs.errors24h === 1 ? '' : 's'} and ${i.logs.warnings24h} warning${i.logs.warnings24h === 1 ? '' : 's'}.`, fix: 'Open the Logs page, level Error.' }
      : { id: 'errors', group: 'Logs', title: 'Errors (24 h)', status: 'pass', detail: `No errors; ${i.logs.warnings24h} warning${i.logs.warnings24h === 1 ? '' : 's'}.` },
  );

  // ---- Prices
  const p = i.pricing;
  if (!p.enabled) add({ id: 'pricing', group: 'Prices', title: 'Daily price update', status: 'info', detail: 'Turned off.' });
  else if (!p.lastRun) add({ id: 'pricing', group: 'Prices', title: 'Daily price update', status: p.running ? 'info' : 'warn', detail: p.running ? 'The first update is running.' : `Not run yet; it starts after ${p.hour}:00 (${p.timeZone}).`, fix: p.running ? undefined : 'Run it now under Prices.' });
  else {
    const ran = hoursSince(p.lastRun.finishedAt, i.now);
    const failed = p.lastRun.counts.failed ?? 0;
    add({
      id: 'pricing',
      group: 'Prices',
      title: 'Daily price update',
      status: ran > 30 ? 'fail' : failed ? 'warn' : 'pass',
      detail: `Last run ${p.lastRun.date}: ${p.lastRun.counts.updated ?? 0} updated, ${p.lastRun.counts.needsMatch ?? 0} need a match, ${failed} failed.`,
      fix: ran > 30 ? 'It should run every day. Check the Logs page (category pricing).' : failed ? 'See the problems under Prices; the sites may have changed or blocked the server.' : undefined,
    });
  }
  // An update that was interrupted, stalled or failed (its banner hasn't been dismissed yet).
  if (p.problem) add({ id: 'pricing-problem', group: 'Prices', title: 'Price update problem', status: p.problem.recoveredAt ? 'warn' : 'fail', detail: `${p.problem.title}. ${p.problem.message}`, fix: 'See the red banner under Prices: it shows the update’s log. Start it again or dismiss it there.' });
  if (p.enabled && p.rateDate) {
    const days = hoursSince(`${p.rateDate}T21:00:00Z`, i.now) / 24;
    add({ id: 'fx', group: 'Prices', title: 'Exchange rate', status: days > 5 ? 'warn' : 'pass', detail: `Bank of Canada rate from ${p.rateDate}.`, fix: days > 5 ? 'The Bank of Canada rate is out of date; check the Logs page (category pricing).' : undefined });
  }

  // ---- Server
  const free = i.disk.freeBytes;
  add(
    free == null
      ? { id: 'disk', group: 'Server', title: 'Disk space', status: 'info', detail: `The ledger uses ${mb(i.disk.dataBytes)}.` }
      : { id: 'disk', group: 'Server', title: 'Disk space', status: free < 200 * 1048576 ? 'fail' : free < 1024 * 1048576 ? 'warn' : 'pass', detail: `${mb(free)} free; the ledger uses ${mb(i.disk.dataBytes)}.`, fix: free < 1024 * 1048576 ? 'Free some space on the server (old Docker images: docker image prune).' : undefined },
  );
  return c;
}

export function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    // Unreadable parts are left out.
  }
  return total;
}
