import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CheckInputs, runChecks } from '#domain/admin/checks.ts';
import { statusText } from '#domain/admin/status.ts';

const now = new Date('2026-10-03T12:00:00.000Z');
const healthy: CheckInputs = {
  now,
  secure: true,
  untrustedProxy: false,
  localRequest: false,
  authEnabled: true,
  accounts: { users: 2, admins: 2, adminsMustChange: 0, settings: { passwordMinLength: 10, lockoutAfter: 5 }, tokensExpired: 0, tokensStale: 0, setupPending: false },
  envPasswordStillWorks: false,
  security: { enabled: true, bans: 0, limited: 0, blocked: 0, allowlist: 0 },
  failedSignIns24h: 0,
  backups: { newestDaily: '2026-10-03T00:10:00.000Z', dailyCopies: 3, snapshots: 1, retention: { daily: 14, weekly: 8, monthly: 12 } },
  lastFullBackupAt: null,
  offsite: { at: '2026-10-03T03:00:00.000Z', where: 'gs://b/binder.tar.gz' },
  logs: { fileOk: true, dir: '/data/logs', errors24h: 0, warnings24h: 1 },
  pricing: { enabled: true, hour: 5, timeZone: 'America/Vancouver', lastRun: { date: '2026-10-03', finishedAt: '2026-10-03T06:00:00.000Z', counts: { updated: 9, needsMatch: 0, failed: 0 } }, running: false, rateDate: '2026-10-02', problem: null },
  disk: { freeBytes: 5 * 1024 * 1048576, dataBytes: 3 * 1048576 },
};
const statuses = (i: CheckInputs) => Object.fromEntries(runChecks(i).map((c) => [c.id, c.status]));

describe('the overview checks', () => {
  it('pass on a healthy server behind HTTPS', () => {
    const s = statuses(healthy);
    assert.ok(Object.values(s).every((v) => v === 'pass' || v === 'info'), JSON.stringify(s));
    assert.deepEqual(Object.keys(s), ['auth', 'admins', 'pw-length', 'lockout', 'failed-signins', 'https', 'headers', 'rate-limits', 'daily-copy', 'offsite', 'log-files', 'errors', 'pricing', 'fx', 'disk']);
  });

  it('say what to fix when something is wrong', () => {
    const checks = runChecks({
      ...healthy,
      secure: false,
      untrustedProxy: true,
      authEnabled: false,
      accounts: null,
      envPasswordStillWorks: true,
      backups: { ...healthy.backups, newestDaily: null },
      offsite: null,
      pricing: { ...healthy.pricing, problem: { title: 'The price update stalled', message: 'No progress for 11 minutes.' } },
      disk: { freeBytes: 100 * 1048576, dataBytes: 0 },
    });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.deepEqual(
      ['auth', 'env-password', 'https', 'proxy', 'daily-copy', 'offsite', 'pricing-problem', 'disk'].map((id) => byId[id]?.status),
      ['fail', 'warn', 'fail', 'fail', 'fail', 'warn', 'fail', 'fail'],
    );
    assert.equal(byId['daily-copy']?.detail, 'No daily copy yet.');
    assert.equal(byId['offsite']?.detail, 'No full backup has been downloaded from here.');
    assert.equal(byId['pricing-problem']?.detail, 'The price update stalled. No progress for 11 minutes.');
    assert.match(byId['disk']?.fix ?? '', /docker image prune/);
  });

  it('tell how long ago the nightly job copied a backup off the server', () => {
    const offsite = (at: string) => runChecks({ ...healthy, offsite: { at, where: 'gs://x/y' } }).find((c) => c.id === 'offsite');
    assert.deepEqual(offsite('2026-10-03T03:00:00.000Z'), { id: 'offsite', group: 'Backups', title: 'Copy off the server', status: 'pass', detail: 'The nightly job copied a backup to gs://x/y today.' });
    assert.equal(offsite('2026-09-28T12:00:00.000Z')?.detail, 'The nightly job last copied a backup off the server 5 days ago.');
  });

  it('flag a price update that has not run for over 30 hours, or had failures', () => {
    const pricing = (finishedAt: string, failed: number) => runChecks({ ...healthy, pricing: { ...healthy.pricing, lastRun: { date: finishedAt.slice(0, 10), finishedAt, counts: { failed } } } }).find((c) => c.id === 'pricing');
    assert.equal(pricing('2026-10-02T05:00:00.000Z', 0)?.status, 'fail');
    assert.equal(pricing('2026-10-03T06:00:00.000Z', 2)?.status, 'warn');
    assert.equal(pricing('2026-10-03T06:00:00.000Z', 2)?.detail, 'Last run 2026-10-03: 0 updated, 0 need a match, 2 failed.');
  });
});

describe('status.txt', () => {
  it('has a line per check (but not the ones about the request) and per card that needs a person', () => {
    const checks = runChecks({ ...healthy, secure: false, backups: { ...healthy.backups, newestDaily: null } });
    const lines = statusText(now, checks, ['Bill Base Set 118/130: no certain match.  Open the card\nand choose the product.']).trimEnd().split('\n');
    assert.equal(lines[0], 'written 2026-10-03T12:00:00.000Z');
    assert.ok(!lines.some((l) => l.includes('HTTPS')));
    assert.ok(lines.includes('fail Daily copies on the server: No daily copy yet. Fix: Take a snapshot under Backups now; check the Logs page (category backup) for errors.'));
    assert.equal(lines.at(-1), 'attention Bill Base Set 118/130: no certain match. Open the card and choose the product.');
  });
});
