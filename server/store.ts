import fs from 'node:fs';
import path from 'node:path';
import { type Damaged, damagedMessage, readJson, setAside } from './recover';
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

export class NotFound extends Error {}
/** The ledger couldn't be written (a full disk, say): the change wasn't made. */
export class SaveFailed extends Error {}

export class Store {
  readonly file: string;
  readonly backupDir: string;
  private data: Data;
  private readonly listeners = new Set<(e: Event) => void>();
  /** Called after a new daily copy is taken (the backups module applies retention). */
  onDailyCopy: (() => void) | null = null;
  /** Something that went wrong without stopping a change (a daily copy, a listener): logged by index.ts. */
  onError: ((what: string, err: unknown) => void) | null = null;
  /** The ledger file was damaged at start and this copy was loaded instead (index.ts logs it). */
  readonly recovered: { damaged: Damaged; from: string; message: string } | null = null;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'db.json');
    this.backupDir = path.join(dataDir, 'backups');
    let damaged: Damaged | null = null;
    let raw = readJson<Partial<Data>>(this.file, (d) => (damaged = d), { keep: true });
    if (damaged) {
      // The newest copy that reads; without one, stop rather than start with an empty ledger
      // (the damaged file stays where it is, for a person to rescue).
      const copy = this.newestGoodCopy();
      const d = damaged as Damaged;
      if (!copy) throw new Error(damagedMessage(d, `No copy in ${this.backupDir} could be read either, so the server won't start with an empty ledger. Restore a copy by hand (deploy/README.md) and start it again.`));
      raw = copy.data;
      d.setAside = setAside(this.file);
      this.recovered = { damaged: d, from: copy.name, message: damagedMessage(d, `The ledger was loaded from the copy ${copy.name}; changes made after that copy was taken are missing.`) };
    }
    this.data = raw ? normalize(raw) : emptyData();
    if (this.recovered) this.persist();
  }

  /** The newest copy of the ledger in backups/ that can be read. */
  private newestGoodCopy(): { name: string; data: Partial<Data> } | null {
    let names: string[];
    try {
      names = fs.readdirSync(this.backupDir).filter((f) => /^db-.+\.json$/.test(f));
    } catch {
      return null;
    }
    const newest = names.map((name) => ({ name, t: fs.statSync(path.join(this.backupDir, name)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { name } of newest) {
      const data = readJson<Partial<Data>>(path.join(this.backupDir, name), () => {}, { keep: true });
      if (data && COLLECTIONS.some((c) => data[c] && typeof data[c] === 'object')) return { name, data };
    }
    return null;
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

  /**
   * Merge fields into several documents as one change: every result is checked first, so either
   * all of them are saved or none is (a binder sorted halfway would be worse than not at all).
   */
  updateMany(collection: Collection, patches: { id: string; patch: Doc }[]): number {
    const next = patches.map(({ id, patch }) => {
      const cur = this.data[collection][id];
      if (!cur) throw new NotFound(`No ${collection.replace(/s$/, '')} with id ${id}`);
      return { id, doc: validateDoc(collection, { ...cur, ...patch }) };
    });
    if (!next.length) return 0;
    const before = next.map(({ id }) => ({ id, doc: this.data[collection][id] }));
    for (const { id, doc } of next) this.data[collection][id] = doc;
    try {
      this.save();
    } catch (err) {
      for (const { id, doc } of before) this.data[collection][id] = doc;
      throw err;
    }
    for (const { id, doc } of next) this.emit({ type: 'change', change: { collection, id, doc } });
    return next.length;
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
    const before = this.data;
    this.data = next;
    try {
      this.persist();
    } catch (err) {
      this.data = before;
      throw err;
    }
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

  /** Make a change; if it can't be saved, it's undone (memory never differs from the file) and SaveFailed thrown. */
  private commit(change: Change) {
    const bucket = this.data[change.collection];
    const before = bucket[change.id];
    if (change.doc) bucket[change.id] = change.doc;
    else delete bucket[change.id];
    try {
      this.save();
    } catch (err) {
      if (before) bucket[change.id] = before;
      else delete bucket[change.id];
      throw err;
    }
    this.emit({ type: 'change', change });
  }

  /** The day's copy (a failure there doesn't stop the change), then the ledger itself. */
  private save() {
    try {
      this.dailyCopy();
    } catch (err) {
      this.onError?.("Taking today's copy of the ledger", err);
    }
    this.persist();
  }

  /** Every listener hears every change, even if one before it fails. */
  private emit(e: Event) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        this.onError?.('Telling the pages about a change', err);
      }
    }
  }

  private persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new SaveFailed(`Couldn't save the ledger: ${err instanceof Error ? err.message : err}. Nothing was changed; try again once the server has room.`);
    }
  }

  /** First change of each day: keep the ledger as it was, so a bad edit can be undone. */
  private dailyCopy() {
    if (!fs.existsSync(this.file)) return;
    const name = `db-${new Date().toISOString().slice(0, 10)}.json`;
    if (fs.existsSync(path.join(this.backupDir, name))) return;
    this.keepCopy(name.slice(3, -5));
    this.onDailyCopy?.();
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
