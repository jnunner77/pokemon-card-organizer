import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Accounts } from '../server/accounts';
import { createApp } from '../server/app';
import { Assets } from '../server/assets';
import { Config } from '../server/config';
import { Guests } from '../server/guests';
import { Logger } from '../server/log';
import { readJson, safely } from '../server/recover';
import { SaveFailed, Store } from '../server/store';

// Recovering instead of stopping: damaged files set aside (the ledger loaded from its newest good
// copy), a save that fails leaves nothing half-changed, and jobs that fail are logged and go on.

let dir: string;
let log: Logger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-recover-'));
  log = new Logger({ stdout: false });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const card = (name: string) => ({ name, set: '151', number: '131/165', status: 'binder', prices: [] });
const damaged = (name: string) => fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.damaged-`));

describe('a damaged ledger file', () => {
  it('is set aside and the newest good copy loaded', () => {
    const s = new Store(dir);
    s.set('cards', 'c1', card('Lapras'));
    // Yesterday's copy, and an older one.
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backups', 'db-2026-10-01.json'), JSON.stringify({ cards: { old: card('Old') }, binders: {}, settings: {} }));
    fs.writeFileSync(path.join(dir, 'backups', 'db-2026-10-02.json'), JSON.stringify({ cards: { c1: card('Lapras') }, binders: {}, settings: {} }));
    fs.utimesSync(path.join(dir, 'backups', 'db-2026-10-01.json'), new Date('2026-10-01'), new Date('2026-10-01'));
    fs.writeFileSync(path.join(dir, 'backups', 'db-2026-10-03.json'), '{"cards": {"c1"'); // newest, but cut short too
    fs.writeFileSync(path.join(dir, 'db.json'), '{"cards": {"c1": {"name": "Lap'); // cut short by a full disk
    const r = new Store(dir);
    expect(r.recovered).toMatchObject({ from: 'db-2026-10-02.json' });
    expect(r.recovered!.message).toMatch(/^db\.json was damaged \(.+\); it was kept as db\.json\.damaged-.+\. The ledger was loaded from the copy db-2026-10-02\.json; changes made after that copy was taken are missing\.$/);
    expect(r.get('cards', 'c1')).toMatchObject({ name: 'Lapras' });
    expect(damaged('db.json')).toHaveLength(1);
    // The good ledger is back in place for the next start.
    expect(new Store(dir).recovered).toBeNull();
  });

  it('stops the server, leaving the file in place, when no copy can be read', () => {
    fs.writeFileSync(path.join(dir, 'db.json'), 'not json');
    expect(() => new Store(dir)).toThrow(/db\.json was damaged .*won't start with an empty ledger/);
    expect(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).toBe('not json');
  });
});

describe('a save that fails', () => {
  it('changes nothing, in memory or on disk, and says why', () => {
    const s = new Store(dir);
    s.set('cards', 'c1', card('Lapras'));
    s.set('cards', 'c2', card('Mew'));
    // The ledger can't be written any more (as on a full disk).
    fs.rmSync(path.join(dir, 'db.json'));
    fs.mkdirSync(path.join(dir, 'db.json'));
    expect(() => s.set('cards', 'c1', card('Changed'))).toThrow(SaveFailed);
    expect(() => s.set('cards', 'c3', card('New'))).toThrow(/^Couldn't save the ledger: .+\. Nothing was changed; try again once the server has room\.$/);
    expect(() => s.delete('cards', 'c2')).toThrow(SaveFailed);
    expect(() => s.updateMany('cards', [{ id: 'c1', patch: { name: 'A' } }, { id: 'c2', patch: { name: 'B' } }])).toThrow(SaveFailed);
    expect(s.all().cards.map((c) => [c.id, (c as { name?: string }).name])).toEqual([['c1', 'Lapras'], ['c2', 'Mew']]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('goes on when only the daily copy fails, or a listener does', () => {
    const s = new Store(dir);
    const errors: string[] = [];
    s.onError = (what, err) => errors.push(`${what}: ${err instanceof Error ? err.message : err}`);
    fs.writeFileSync(path.join(dir, 'backups'), 'a file where the folder should be');
    s.set('cards', 'c1', card('Lapras'));
    s.set('cards', 'c1', card('Lapras')); // now db.json exists: today's copy is attempted
    expect(errors[0]).toMatch(/^Taking today's copy of the ledger: /);
    const heard: string[] = [];
    s.subscribe(() => {
      throw new Error('a page went away');
    });
    s.subscribe((e) => heard.push(e.type));
    s.set('cards', 'c2', card('Mew'));
    expect(heard).toEqual(['change']);
    expect(errors).toContain('Telling the pages about a change: a page went away');
    expect(new Store(dir).get('cards', 'c2')).toMatchObject({ name: 'Mew' });
  });

  it('is answered 503 and logged, so it shows in the problems banner', async () => {
    const store = new Store(dir);
    const app = createApp({ store, assets: new Assets(dir), log, config: new Config(dir), publicDir: path.join(__dirname, '../public') });
    fs.mkdirSync(path.join(dir, 'db.json'));
    const r = await request(app).put('/api/docs/cards/c1').send(card('Lapras')).expect(503);
    expect(r.body).toMatchObject({ code: 'save_failed', error: expect.stringMatching(/^Couldn't save the ledger/) });
    expect(log.query({ level: 'error', text: 'save the ledger' })[0].msg).toMatch(/^PUT \/api\/docs\/cards\/c1: Couldn't save the ledger/);
  });
});

describe('other damaged files', () => {
  it('admin.json: set aside, defaults used', () => {
    fs.writeFileSync(path.join(dir, 'admin.json'), '{"pricing": {"hour": 7');
    const c = new Config(dir);
    expect(c.get().pricing).toMatchObject({ enabled: true, hour: 5 });
    expect(c.recovered).toMatch(/^admin\.json was damaged .*The default settings are used/);
    expect(damaged('admin.json')).toHaveLength(1);
  });

  it('guests.json: set aside, guest viewing closed, logged', () => {
    fs.writeFileSync(path.join(dir, 'guests.json'), '[1,2');
    const g = new Guests(dir, log);
    expect(g.settings.enabled).toBe(false);
    expect(log.query({ level: 'error' })[0].msg).toMatch(/^guests\.json was damaged .*Guest viewing starts closed/);
    expect(damaged('guests.json')).toHaveLength(1);
  });

  it('sessions.json: set aside, everyone signs in again; auth.json: the server stops, keeping the file', async () => {
    const a = new Accounts(dir, log);
    await a.bootstrap('start password 1');
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{"sessions": [');
    expect(() => new Accounts(dir, log)).not.toThrow();
    expect(log.query({ level: 'error', cat: 'auth' })[0].msg).toMatch(/^sessions\.json was damaged .*Everyone needs to sign in again\.$/);
    const before = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'auth.json'), before.slice(0, 40));
    expect(() => new Accounts(dir, log)).toThrow(/auth\.json was damaged .*won't start without its accounts/);
    expect(fs.existsSync(path.join(dir, 'auth.json'))).toBe(true);
    expect(damaged('auth.json')).toHaveLength(0);
  });

  it('reads a missing file as none, and a JSON array or null as damaged', () => {
    const seen: string[] = [];
    expect(readJson(path.join(dir, 'none.json'), () => seen.push('x'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'a.json'), '[]');
    fs.writeFileSync(path.join(dir, 'b.json'), 'null');
    expect(readJson(path.join(dir, 'a.json'), (d) => seen.push(d.error))).toBeNull();
    expect(readJson(path.join(dir, 'b.json'), (d) => seen.push(d.error), { keep: true })).toBeNull();
    expect(seen).toEqual(['it is not a JSON object', 'it is not a JSON object']);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(true);
  });
});

describe('background jobs', () => {
  it('log their errors, thrown or rejected, and never throw on', async () => {
    expect(() => safely(log, 'backup', 'Housekeeping', () => { throw new Error('ENOSPC'); })).not.toThrow();
    safely(log, 'app', 'Writing the status file', () => Promise.reject(new Error('EACCES')));
    await new Promise((r) => setTimeout(r, 0));
    expect(log.query({ level: 'error' }).map((e) => e.msg.split('\n')[0])).toEqual(['Writing the status file failed: Error: EACCES', 'Housekeeping failed: Error: ENOSPC']);
  });
});
