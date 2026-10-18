import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { guestValue } from '#domain/guests/guest-card.ts';
import { PageConditionRules } from '#infrastructure/guests/condition-rules.ts';
import { FileGuestDesk } from '#infrastructure/guests/guest-file.ts';
import { StoreLedgerChanges } from '#infrastructure/json-store/ledger-changes.ts';
import { ok } from '#shared/result.ts';
import { tempStore } from '../json-store/fixtures.ts';

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-guests-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const NOW = new Date('2026-10-05T18:00:00.000Z');
const visit = { id: 'g1', name: 'Misty', contact: 'misty@cerulean.gym', contactKind: 'email' as const, ip: '', agent: '', startedAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), endedAt: null, ended: null };

describe('FileGuestDesk', () => {
  it('starts closed with a new key, saved in guests.json readable only by the server', async () => {
    const dir = tempDir();
    const desk = new FileGuestDesk({ dataDir: dir, now: () => NOW, newKey: () => 'fresh', onDamaged: () => assert.fail('not damaged') });
    assert.deepEqual((await desk.read()).book, { settings: { enabled: false, key: 'fresh', keyCreatedAt: NOW.toISOString() }, log: [] });
    assert.equal(fs.statSync(path.join(dir, 'guests.json')).mode & 0o077, 0);
  });

  it('saves the book only when a change says it changed; signed-in guests stay in memory', async () => {
    const dir = tempDir();
    const desk = new FileGuestDesk({ dataDir: dir, now: () => NOW, newKey: () => 'k', onDamaged: () => {} });
    const session = { id: 'g1', hash: 'h', name: 'Misty', nameKey: 'misty', contact: 'm', contactKey: 'm', contactKind: 'email' as const, ip: '', agent: '', createdAt: 0, lastSeen: 0 };
    await desk.change((s) => {
      s.sessions = [session];
      s.book = { ...s.book, log: [visit] };
      return ok(undefined);
    });
    assert.deepEqual((await desk.read()).sessions, [session]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'guests.json'), 'utf8')).log, []);
    await desk.change((s) => {
      s.book = { ...s.book, log: [visit] };
      s.bookChanged = true;
      return ok(undefined);
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'guests.json'), 'utf8')).log.length, 1);
  });

  it('keeps the log and settings across restarts, closing visits that were open', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'guests.json'), JSON.stringify({ settings: { enabled: true, key: 'k', keyCreatedAt: NOW.toISOString() }, log: [visit] }));
    const desk = new FileGuestDesk({ dataDir: dir, now: () => NOW, newKey: () => 'other', onDamaged: () => {} });
    const { book, sessions } = await desk.read();
    assert.equal(book.settings.enabled, true);
    assert.equal(book.settings.key, 'k');
    assert.deepEqual(book.log[0], { ...visit, endedAt: NOW.toISOString(), ended: 'restart' });
    assert.deepEqual(sessions, []);
  });

  it('sets a damaged guests.json aside: guest viewing starts closed', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'guests.json'), '[1,2');
    const told: string[] = [];
    const desk = new FileGuestDesk({ dataDir: dir, now: () => NOW, newKey: () => 'k', onDamaged: (m) => told.push(m) });
    assert.equal((await desk.read()).book.settings.enabled, false);
    assert.match(told[0] ?? '', /^guests\.json was damaged .*Guest viewing starts closed/);
  });
});

describe('PageConditionRules', () => {
  it('adjusts automatic (near-mint) prices for the card\'s condition, like the ledger does', () => {
    const rules = new PageConditionRules();
    const adjust = rules.adjust.bind(rules);
    const price = { type: 'market', amount: 10, currency: 'CAD', date: '2026-10-01', at: '2026-10-01T12:00:00Z', auto: true };
    assert.equal(guestValue({ id: 'c1', condition: 'Lightly Played', prices: [price] }, 1.37, adjust), 9);
    assert.equal(guestValue({ id: 'c1', prices: [{ ...price, amount: 20.2 }] }, 1.37, adjust), 21);
  });
});

describe('StoreLedgerChanges', () => {
  it('passes on which collection changed, and a whole-ledger replacement as null', () => {
    const store = tempStore();
    const seen: (string | null)[] = [];
    const stop = new StoreLedgerChanges(store).subscribe((c) => seen.push(c.collection));
    store.set('cards', 'c1', { name: 'Mew' });
    store.replaceAll({ binders: {}, cards: {}, settings: {} });
    stop();
    store.set('cards', 'c2', { name: 'Mew' });
    assert.deepEqual(seen, ['cards', null]);
  });
});
