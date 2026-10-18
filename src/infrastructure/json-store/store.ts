import fs from 'node:fs';
import path from 'node:path';
import { beforeRestoreName, dailyCopyName } from '#domain/backups/copies.ts';
import { checkDocument } from '#domain/ledger/check-document.ts';
import { COLLECTIONS, type Collection, isRecord, singular } from '#domain/ledger/document.ts';
import { photosReferencedBy } from '#domain/photos/references.ts';
import { type Damaged, damagedMessage, readJson, setAside } from './damaged.ts';

// The ledger is small (a collector's cards, not a warehouse), so it lives in one JSON file
// that is rewritten atomically on every change. Photos are stored as separate files by
// infrastructure/photos. Each change is pushed to connected browsers so every open tab stays
// in step, the same way the original artifact's shared database behaved.

export type Doc = Record<string, unknown>;
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

/** A document that breaks the ledger's rules (domain/ledger/check-document.ts). */
export class InvalidDoc extends Error {}
export class NotFound extends Error {}
/** The ledger couldn't be written (a full disk, say): the change wasn't made. */
export class SaveFailed extends Error {}

/** Check a document about to be saved; its fields without the id, or InvalidDoc thrown. */
export function validateDoc(collection: Collection, doc: unknown): Doc {
  const r = checkDocument(collection, doc);
  if (!r.ok) throw new InvalidDoc(r.error.message);
  return { ...r.value };
}

const notFound = (collection: Collection, id: string) => new NotFound(`No ${singular(collection)} with id ${id}`);

export class Store {
  readonly dataDir: string;
  readonly file: string;
  readonly backupDir: string;
  private data: Data;
  /** Goes up with every saved change, so a unit of work can tell the ledger changed under it. */
  private changes = 0;
  private readonly listeners = new Set<(e: Event) => void>();
  /** Called after a new daily copy is taken (the backups module applies retention). */
  onDailyCopy: (() => void) | null = null;
  /** Something that went wrong without stopping a change (a daily copy, a listener): logged by main.ts. */
  onError: ((what: string, err: unknown) => void) | null = null;
  /** The ledger file was damaged at start and this copy was loaded instead (main.ts logs it). */
  readonly recovered: { damaged: Damaged; from: string; message: string } | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'db.json');
    this.backupDir = path.join(dataDir, 'backups');
    let damaged: Damaged | null = null;
    let raw = readJson<Partial<Data>>(this.file, (d) => (damaged = d), { keep: true });
    if (damaged) {
      // The newest copy that reads; without one, stop rather than start with an empty ledger
      // (the damaged file stays where it is, for a person to rescue).
      const copy = this.newestGoodCopy();
      const d: Damaged = damaged;
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
      if (data && COLLECTIONS.some((c) => isRecord(data[c]))) return { name, data };
    }
    return null;
  }

  /** How many changes have been saved since the server started. */
  get version(): number {
    return this.changes;
  }

  /** Every document, grouped by collection, each with its id. */
  all(): Record<Collection, (Doc & { id: string })[]> {
    const list = (c: Collection) => Object.entries(this.data[c]).map(([id, doc]) => ({ id, ...doc }));
    return { binders: list('binders'), cards: list('cards'), settings: list('settings') };
  }

  /** One collection's documents and their ids. */
  entries(collection: Collection): [string, Doc][] {
    return Object.entries(this.data[collection]);
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
    this.commit([{ collection, id, doc: next }]);
    return next;
  }

  /** Merge top-level fields into an existing document. */
  update(collection: Collection, id: string, patch: Doc): Doc {
    const cur = this.data[collection][id];
    if (!cur) throw notFound(collection, id);
    const next = validateDoc(collection, { ...cur, ...patch });
    this.commit([{ collection, id, doc: next }]);
    return next;
  }

  /**
   * Merge fields into several documents as one change: every result is checked first, so either
   * all of them are saved or none is (a binder sorted halfway would be worse than not at all).
   */
  updateMany(collection: Collection, patches: { id: string; patch: Doc }[]): number {
    const next = patches.map(({ id, patch }): Change => {
      const cur = this.data[collection][id];
      if (!cur) throw notFound(collection, id);
      return { collection, id, doc: validateDoc(collection, { ...cur, ...patch }) };
    });
    this.commit(next);
    return next.length;
  }

  /** Create or replace several documents as one change: all of them are saved, or none is (a master set's cards). */
  setMany(collection: Collection, docs: { id: string; doc: Doc }[]): number {
    const next = docs.map(({ id, doc }): Change => ({ collection, id, doc: validateDoc(collection, doc) }));
    this.commit(next);
    return next.length;
  }

  delete(collection: Collection, id: string): void {
    if (!this.data[collection][id]) return;
    this.commit([{ collection, id, doc: null }]);
  }

  /**
   * Save changes to any documents as one change, in order: all of them or none. The documents were
   * checked by the domain already (a unit of work's aggregates).
   */
  transact(changes: readonly Change[]): void {
    this.commit(changes);
  }

  /** Swap in a whole new ledger (a restore). The current one is kept in backups first. */
  replaceAll(data: Data): void {
    const next = emptyData();
    for (const c of COLLECTIONS) for (const [id, doc] of Object.entries(data[c] ?? {})) next[c][id] = validateDoc(c, doc);
    this.keepCopy(beforeRestoreName(new Date()));
    const before = this.data;
    this.data = next;
    try {
      this.persist();
    } catch (err) {
      this.data = before;
      throw err;
    }
    this.changes++;
    this.emit({ type: 'reset' });
  }

  subscribe(fn: (e: Event) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Every image id the ledger points at: people's photos (not inline data: URLs) and official images. */
  referencedImages(): Set<string> {
    return photosReferencedBy(this.data);
  }

  /** Make changes; if they can't be saved, they're undone (memory never differs from the file) and SaveFailed thrown. */
  private commit(changes: readonly Change[]) {
    if (!changes.length) return;
    const before = changes.map(({ collection, id }) => ({ collection, id, doc: this.data[collection][id] }));
    for (const { collection, id, doc } of changes) {
      if (doc) this.data[collection][id] = doc;
      else delete this.data[collection][id];
    }
    try {
      this.save();
    } catch (err) {
      for (const { collection, id, doc } of before.reverse()) {
        if (doc) this.data[collection][id] = doc;
        else delete this.data[collection][id];
      }
      throw err;
    }
    this.changes++;
    for (const change of changes) this.emit({ type: 'change', change });
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
      throw new SaveFailed(`Couldn't save the ledger: ${err instanceof Error ? err.message : String(err)}. Nothing was changed; try again once the server has room.`);
    }
  }

  /** First change of each day: keep the ledger as it was, so a bad edit can be undone. */
  private dailyCopy() {
    if (!fs.existsSync(this.file)) return;
    const name = dailyCopyName(new Date().toISOString().slice(0, 10));
    if (fs.existsSync(path.join(this.backupDir, name))) return;
    this.keepCopy(name);
    this.onDailyCopy?.();
  }

  private keepCopy(name: string) {
    if (!fs.existsSync(this.file)) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    fs.copyFileSync(this.file, path.join(this.backupDir, name));
  }
}

function normalize(raw: Partial<Data>): Data {
  const data = emptyData();
  for (const c of COLLECTIONS) {
    const docs = raw[c];
    if (isRecord(docs)) data[c] = docs as Record<string, Doc>;
  }
  return data;
}
