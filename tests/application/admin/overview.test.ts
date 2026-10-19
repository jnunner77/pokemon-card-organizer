import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setUp } from './fixtures.ts';

const request = { secure: true, untrustedProxy: false, localRequest: false };
const status = (checks: readonly { id: string; status: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe('the overview', () => {
  it('checks the server from what every part reports, with the ledger size and the server', async () => {
    const a = setUp({ accounts: { health: { execute: async () => ({ users: 1, admins: 1, adminsMustChange: 0, settings: { passwordMinLength: 12, lockoutAfter: 5, lockoutMinutes: 15, sessionMaxDays: 30, sessionIdleHours: 24 }, sessions: 1, tokens: 0, tokensExpired: 0, tokensStale: 0, setupPending: false }) }, envPasswordWorks: { execute: async (i) => i.envPassword === 'start' }, envPassword: 'start' } });
    a.ledger.tables.cards.set('c1', { name: 'Mew' });
    a.ledger.tables.binders.set('b1', { name: 'Main' });
    a.priceRecord.lastRun = { date: '2026-10-03', finishedAt: '2026-10-03T06:00:00.000Z', counts: { updated: 3, failed: 0 } };
    a.priceRecord.rateDate = '2026-10-02';
    for (let i = 0; i < 3; i++) a.log.warn('auth', 'Failed sign-in for misty');
    const report = await a.overview.execute(request);
    assert.deepEqual(report.ledger, { binders: 1, cards: 1, photos: 0, bytes: 0, trashed: 0 });
    assert.deepEqual(report.server, { node: 'v22.18.0', uptimeHours: 1.5, startedAt: '2026-10-18T10:30:00.000Z' });
    const s = status(report.checks);
    assert.deepEqual([s['auth'], s['admins'], s['env-password'], s['daily-copy'], s['pricing'], s['fx'], s['offsite']], ['pass', 'info', 'warn', 'pass', 'pass', 'pass', 'warn']);
    assert.equal(report.checks.find((c) => c.id === 'failed-signins')?.detail, '3 failed sign-ins.');
    assert.equal(report.checks.find((c) => c.id === 'errors')?.detail, 'No errors; 3 warnings.');
  });

  it('without sign-in, the daily update or a log folder, says so', async () => {
    const a = setUp({ prices: false });
    a.security.current = { enabled: false, bans: 0, limited: 0, blocked: 0, allowlist: 0 };
    a.disk.free = null;
    const s = status(await a.checks.execute({ secure: false, untrustedProxy: false, localRequest: true }));
    assert.deepEqual([s['auth'], s['https'], s['rate-limits'], s['pricing'], s['log-files'], s['disk']], ['fail', 'info', 'fail', 'info', 'warn', 'info']);
  });

  it('writes status.txt with the checks and the cards that need a person', async () => {
    const a = setUp();
    a.ledger.tables.cards.set('c1', { name: 'Bill', set: 'Base Set', number: '118/130', status: 'binder', pricing: { source: 'none', candidates: [] } });
    a.offsite.copy = { at: '2026-10-03T03:00:00.000Z', where: 'gs://b/x' };
    await a.writeStatusFile.execute();
    const lines = (a.statusFile.text ?? '').trimEnd().split('\n');
    assert.equal(lines[0], 'written 2026-10-03T12:00:00.000Z');
    assert.ok(lines.includes('ok Copy off the server: The nightly job copied a backup to gs://b/x today.'));
    assert.equal(lines.at(-1), 'attention Bill Base Set 118/130: no certain match. Open the card and choose the product.');
  });
});
