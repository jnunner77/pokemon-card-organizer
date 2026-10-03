import fs from 'node:fs';
import path from 'node:path';
import type { Assets } from './assets';
import type { Config, Retention } from './config';
import type { Logger } from './log';
import { HttpError } from './security';
import type { Data, Store } from './store';

// Copies of the ledger (db.json) kept on the server, in <data>/backups:
//
// - daily:   db-YYYY-MM-DD.json, taken once a day (and before the first change of a day).
//            Kept with tiered retention: the newest N days, plus the newest copy of each of the
//            last W weeks, plus the newest copy of each of the last M months, so the copies
//            thin out with age (two weeks of days, two months of weeks, a year of months).
// - snapshot: db-snapshot-<time>[-label].json, taken by an administrator; kept until deleted.
// - before-restore: db-before-restore-<time>.json, taken automatically before any restore.
//
// Photos aren't copied: they never change once stored, and deleted ones stay in the photo
// trash for 400 days (longer than the oldest monthly copy), so restoring a copy brings them back.

export type BackupKind = 'daily' | 'snapshot' | 'before-restore';
export interface BackupFile {
  name: string;
  kind: BackupKind;
  /** When the copy was taken (from the name for daily copies). */
  at: string;
  bytes: number;
  label?: string;
}

const NAME = /^db-(\d{4}-\d{2}-\d{2}|snapshot-[\w-]+|before-restore-[\w-]+)\.json$/;
const MAX_SNAPSHOTS = 50;
const MAX_BEFORE_RESTORE = 10;

/** ISO week ("2026-W40") of a YYYY-MM-DD date. */
export function isoWeek(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Which daily copies (by date, YYYY-MM-DD) tiered retention keeps. */
export function retain(days: string[], r: Retention): Set<string> {
  const sorted = [...new Set(days)].sort().reverse();
  const keep = new Set(sorted.slice(0, r.daily));
  const newestPer = (key: (d: string) => string, n: number) => {
    const seen = new Set<string>();
    for (const d of sorted) {
      const k = key(d);
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > n) break;
      keep.add(d);
    }
  };
  newestPer(isoWeek, r.weekly);
  newestPer((d) => d.slice(0, 7), r.monthly);
  return keep;
}

export class Backups {
  readonly dir: string;

  constructor(
    private readonly store: Store,
    private readonly assets: Assets,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = store.backupDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list(): BackupFile[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => NAME.test(f))
      .map((name) => {
        const st = fs.statSync(path.join(this.dir, name));
        const kind: BackupKind = name.startsWith('db-snapshot-') ? 'snapshot' : name.startsWith('db-before-restore-') ? 'before-restore' : 'daily';
        const label = kind === 'snapshot' ? name.replace(/^db-snapshot-[\dT-]+Z?-?/, '').replace(/\.json$/, '').replace(/-/g, ' ') || undefined : undefined;
        return { name, kind, at: kind === 'daily' ? `${name.slice(3, 13)}T00:00:00.000Z` : st.mtime.toISOString(), bytes: st.size, ...(label ? { label } : {}) };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  private stamp() {
    return this.now().toISOString().replace(/[:.]/g, '-');
  }

  /** Take today's daily copy if there isn't one yet, then apply retention. */
  ensureDaily(day = this.now().toISOString().slice(0, 10)) {
    const file = path.join(this.dir, `db-${day}.json`);
    if (!fs.existsSync(file) && fs.existsSync(this.store.file)) {
      fs.copyFileSync(this.store.file, file);
      this.log.info('backup', `Took the daily copy for ${day}`);
    }
    this.prune();
  }

  snapshot(label: string | undefined, by: string): BackupFile {
    const clean = (label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const name = `db-snapshot-${this.stamp()}${clean ? '-' + clean : ''}.json`;
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(this.store.raw()));
    this.log.info('backup', `${by} took a snapshot${label ? ` "${label}"` : ''}`, { by, name });
    this.prune();
    return this.list().find((b) => b.name === name)!;
  }

  /** Drop copies retention no longer keeps. */
  prune() {
    const files = this.list();
    const keepDays = retain(
      files.filter((f) => f.kind === 'daily').map((f) => f.name.slice(3, 13)),
      this.config.get().backups,
    );
    const drop = [
      ...files.filter((f) => f.kind === 'daily' && !keepDays.has(f.name.slice(3, 13))),
      ...files.filter((f) => f.kind === 'snapshot').slice(MAX_SNAPSHOTS),
      ...files.filter((f) => f.kind === 'before-restore').slice(MAX_BEFORE_RESTORE),
    ];
    for (const f of drop) fs.rmSync(path.join(this.dir, f.name), { force: true });
    if (drop.length) this.log.info('backup', `Removed ${drop.length} old cop${drop.length === 1 ? 'y' : 'ies'} of the ledger`, { names: drop.map((f) => f.name) });
    return drop.length;
  }

  file(name: string) {
    if (!NAME.test(name)) throw new HttpError(404, 'No such backup', 'not_found');
    const p = path.join(this.dir, name);
    if (!fs.existsSync(p)) throw new HttpError(404, 'No such backup', 'not_found');
    return p;
  }

  remove(name: string, by: string) {
    fs.rmSync(this.file(name));
    this.log.info('backup', `${by} deleted the copy ${name}`, { by, name });
  }

  /** Put a copy back as the ledger. The current ledger is kept first; trashed photos it needs come back. */
  restore(name: string, by: string) {
    const raw = JSON.parse(fs.readFileSync(this.file(name), 'utf8')) as Data;
    this.store.replaceAll(raw);
    let recovered = 0;
    for (const id of this.store.referencedImages()) if (!this.assets.find(id) && this.assets.untrash(id)) recovered++;
    this.log.warn('backup', `${by} restored the ledger from ${name}`, { by, name, photosRecovered: recovered });
    return { cards: this.store.all().cards.length, photosRecovered: recovered };
  }

  /** For the Checks page: the newest daily copy and how much is kept. */
  health() {
    const files = this.list();
    const daily = files.filter((f) => f.kind === 'daily');
    return { newestDaily: daily[0]?.at ?? null, dailyCopies: daily.length, snapshots: files.filter((f) => f.kind === 'snapshot').length, bytes: files.reduce((t, f) => t + f.bytes, 0), retention: this.config.get().backups };
  }
}
