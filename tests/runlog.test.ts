import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/runlog.js is a plain browser script; load it the way the pages do.
type Entry = { at: string; level: 'info' | 'warn' | 'error'; cat: string; msg: string; data?: Record<string, unknown> };
type Problem = { kind: string; title: string; message: string; at: string; startedAt: string | null; done: number; total: number; recoveredAt?: string | null };
type RunLog = {
  banner: (p: Problem | null, o?: { running?: boolean; canEdit?: boolean; log?: { entries?: Entry[]; error?: string } | null; timeZone?: string }) => string;
  text: (p: Problem | null, entries: Entry[], timeZone?: string) => string;
  line: (e: Entry, timeZone?: string) => string;
  stat: (st: { running?: boolean; problem?: Problem | null }) => { label: string; count: string } | null;
  key: (p: Problem | null) => string;
};
const sandbox = { window: {} as { BinderRunLog: RunLog }, Intl, Date, JSON, Object, String, Number };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/runlog.js'), 'utf8'), sandbox);
const { banner, text, line, stat, key } = sandbox.window.BinderRunLog;
const tz = 'America/Vancouver';

const problem: Problem = {
  kind: 'interrupted',
  title: 'The price update was interrupted at card 25 of 40',
  message: 'The server stopped unexpectedly during the update. It was asking PriceCharting for <Lapras>.',
  at: '2026-10-03T13:00:00.000Z',
  startedAt: '2026-10-03T12:05:00.000Z',
  done: 24,
  total: 40,
};
const entries: Entry[] = [
  { at: '2026-10-03T12:05:00.000Z', level: 'info', cat: 'pricing', msg: 'Price update started (schedule) for 40 cards' },
  { at: '2026-10-03T12:20:09.000Z', level: 'error', cat: 'app', msg: 'The server crashed (uncaught exception): Error: boom', data: { card: 'Lapras' } },
];

describe('the price update problem banner', () => {
  it('says what happened, when, and offers to start again, copy the log and dismiss', () => {
    const h = banner(problem, { canEdit: true, log: { entries }, timeZone: tz });
    expect(h).toContain('role="alert"');
    expect(h).toContain('data-kind="bad"');
    expect(h).toContain('The price update was interrupted at card 25 of 40');
    expect(h).toContain('&lt;Lapras&gt;'); // escaped
    expect(h).toContain('Started Oct 3, 05:05:00, noticed Oct 3, 06:00:00');
    expect(h.match(/data-runprob="(\w+)"/g)).toEqual(['data-runprob="run"', 'data-runprob="copy"', 'data-runprob="dismiss"']);
    expect(h).toContain('<details class="runlog-box" open><summary>The update\'s log (2 lines, newest last)</summary>');
    expect(h).toContain('<span class="ll-error">Oct 3, 05:20:09  ERROR  app  The server crashed (uncaught exception): Error: boom {&quot;card&quot;:&quot;Lapras&quot;}</span>');
  });

  it('offers to stop a stuck update that is still running', () => {
    const h = banner({ ...problem, kind: 'stalled' }, { canEdit: true, running: true, log: null, timeZone: tz });
    expect(h.match(/data-runprob="(\w+)"/g)).toEqual(['data-runprob="stop"', 'data-runprob="copy"', 'data-runprob="dismiss"']);
    expect(h).toContain("Loading the update's log…");
  });

  it('shows viewers what happened, without buttons or the log', () => {
    const h = banner(problem, { canEdit: false, timeZone: tz });
    expect(h).not.toContain('data-runprob');
    expect(h).not.toContain('runlog');
    expect(banner(null)).toBe('');
  });

  it('turns amber once a later update went through, and says so', () => {
    const h = banner({ ...problem, recoveredAt: '2026-10-03T14:00:00.000Z' }, { canEdit: true, log: { entries: [] }, timeZone: tz });
    expect(h).toContain('data-kind="warn"');
    expect(h).toContain('Since then an update went through every card at Oct 3, 07:00:00.');
    expect(h).toContain('No log lines from that time');
    expect(banner(problem, { canEdit: true, log: { error: 'Not found' } })).toContain("Couldn't load the log: Not found");
  });

  it('copies as plain text: the problem, then the log', () => {
    expect(text(problem, entries, tz).split('\n')).toEqual([
      problem.title,
      problem.message,
      '',
      'Oct 3, 05:05:00  info   pricing  Price update started (schedule) for 40 cards',
      'Oct 3, 05:20:09  ERROR  app  The server crashed (uncaught exception): Error: boom {"card":"Lapras"}',
    ]);
    expect(line(entries[0], 'UTC')).toBe('Oct 3, 12:05:00  info   pricing  Price update started (schedule) for 40 cards');
  });

  it('marks the binder page’s price pill', () => {
    expect(stat({ problem })).toEqual({ label: 'Interrupted', count: '24/40' });
    expect(stat({ problem: { ...problem, kind: 'stalled' }, running: true })).toEqual({ label: 'Stuck', count: '24/40' });
    expect(stat({ problem: { ...problem, kind: 'failed' } })).toEqual({ label: 'Failed', count: '24/40' });
    expect(stat({ problem, running: true })).toBeNull(); // a new update is running
    expect(stat({ problem: { ...problem, recoveredAt: problem.at } })).toBeNull();
    expect(stat({})).toBeNull();
    expect(key(problem)).not.toBe(key({ ...problem, recoveredAt: problem.at }));
  });
});
