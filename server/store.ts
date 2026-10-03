import fs from 'node:fs';
import path from 'node:path';
import { COLLECTIONS, type Collection, type Doc, validateDoc } from './schema';

// The ledger is small (a collector's cards, not a warehouse), so it lives in one JSON file
// that is rewritten atomically on every change. Photos are stored as separate files by
// the Assets class. Each change is pushed to connected browsers so every open tab stays
// in step, the same way the original artifact's shared database behaved.

export type Data = Record<Collection, Record<string, Doc>>;

export interface Change {
  collection: Collection;
  id: string;
  /** The document after the change, or null when it was deleted. */
  doc: Doc | null;
}

/** A change pushed to browsers: one document, or "reload everything" after a restore. */
export type Event = { type: 'change'; change: Change } | { type: 'reset' };

const emptyData = (): Data => ({ binders: {}, cards: {}, settings: {} });

/** Daily copies of db.json kept in <data>/backups, oldest dropped first. */
const DAILY_BACKUPS = 14;

export class NotFound extends Error {}

export class Store {
  readonly file: string;
  readonly backupDir: string;
  private data: Data;
  private readonly listeners = new Set<(e: Event) => void>();

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'db.json');
    this.backupDir = path.join(dataDir, 'backups');
    this.data = fs.existsSync(this.file) ? normalize(JSON.parse(fs.readFileSync(this.file, 'utf8'))) : emptyData();
  }

  /** Every document, grouped by collection, each with its id. */
  all() {
    const list = (c: Collection) => Object.entries(this.data[c]).map(([id, doc]) => ({ id, ...doc }));
    return { binders: list('binders'), cards: list('cards'), settings: list('settings') };
  }

  raw(): Data {
    return structuredClone(this.data);
  }

  get(collection: Collection, id: string): Doc | undefined {
    return this.data[collection][id];
  }

  /** Create or replace a document. */
  set(collection: Collection, id: string, doc: Doc): Doc {
    const next = validateDoc(collection, doc);
    this.commit({ collection, id, doc: next });
    return next;
  }

  /** Merge top-level fields into an existing document. */
  update(collection: Collection, id: string, patch: Doc): Doc {
    const cur = this.data[collection][id];
    if (!cur) throw new NotFound(`No ${collection.replace(/s$/, '')} with id ${id}`);
    const next = validateDoc(collection, { ...cur, ...patch });
    this.commit({ collection, id, doc: next });
    return next;
  }

  delete(collection: Collection, id: string) {
    if (!this.data[collection][id]) return;
    this.commit({ collection, id, doc: null });
  }

  /** Swap in a whole new ledger (a restore). The current one is kept in backups first. */
  replaceAll(data: Data) {
    const next = emptyData();
    for (const c of COLLECTIONS) for (const [id, doc] of Object.entries(data[c] ?? {})) next[c][id] = validateDoc(c, doc);
    this.keepCopy('before-restore');
    this.data = next;
    this.persist();
    this.emit({ type: 'reset' });
  }

  subscribe(fn: (e: Event) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Every image id the ledger points at: people's photos (not inline data: URLs) and official images. */
  referencedImages() {
    const ids = new Set<string>();
    for (const c of Object.values(this.data.cards)) {
      if (typeof c.imageId === 'string' && !c.imageId.startsWith('data:')) ids.add(c.imageId);
      if (typeof c.officialImageId === 'string') ids.add(c.officialImageId);
    }
    return ids;
  }

  private commit(change: Change) {
    const bucket = this.data[change.collection];
    if (change.doc) bucket[change.id] = change.doc;
    else delete bucket[change.id];
    this.dailyCopy();
    this.persist();
    this.emit({ type: 'change', change });
  }

  private emit(e: Event) {
    for (const fn of this.listeners) fn(e);
  }

  private persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  /** First change of each day: keep yesterday's file so a bad edit can be undone by hand. */
  private dailyCopy() {
    if (!fs.existsSync(this.file)) return;
    const name = `db-${new Date().toISOString().slice(0, 10)}.json`;
    if (fs.existsSync(path.join(this.backupDir, name))) return;
    this.keepCopy(name.slice(3, -5));
    const daily = fs
      .readdirSync(this.backupDir)
      .filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    for (const f of daily.slice(0, Math.max(0, daily.length - DAILY_BACKUPS))) fs.rmSync(path.join(this.backupDir, f));
  }

  private keepCopy(label: string) {
    if (!fs.existsSync(this.file)) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = label === 'before-restore' ? `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}` : label;
    fs.copyFileSync(this.file, path.join(this.backupDir, `db-${stamp}.json`));
  }
}

function normalize(raw: Partial<Data>): Data {
  const data = emptyData();
  for (const c of COLLECTIONS) if (raw[c] && typeof raw[c] === 'object') data[c] = raw[c] as Record<string, Doc>;
  return data;
}
