import type { LedgerPhotos, PhotoFile, PhotoStore, PhotoUsage } from '#application/photos/ports.ts';
import { type PhotoId, type PhotoType, photoType } from '#domain/photos/photo.ts';
import type { TrashedPhoto } from '#domain/photos/trash.ts';

interface Kept {
  readonly type: PhotoType;
  readonly bytes: Uint8Array;
  readonly at: Date;
}

/** Photos in memory, for application tests; `now` stamps when photos are stored or trashed. */
export class MemoryPhotoStore implements PhotoStore {
  readonly stored = new Map<string, Kept>();
  readonly trashBin = new Map<string, Kept>();
  now: () => Date = () => new Date(0);

  async save(id: PhotoId, bytes: Uint8Array): Promise<void> {
    const type = photoType(bytes);
    if (!type) throw new Error(`The photo ${id} isn't a picture`);
    await this.#toTrash(id);
    this.stored.set(id, { type, bytes: new Uint8Array(bytes), at: this.now() });
  }

  async has(id: PhotoId): Promise<boolean> {
    return this.stored.has(id);
  }

  async open(id: PhotoId): Promise<PhotoFile | null> {
    const p = this.stored.get(id);
    if (!p) return null;
    const bytes = p.bytes;
    return { type: p.type, bytes: bytes.length, modifiedAt: p.at, content: (async function* () { yield bytes; })() };
  }

  async read(id: PhotoId): Promise<{ type: PhotoType; bytes: Uint8Array } | null> {
    const p = this.stored.get(id);
    return p ? { type: p.type, bytes: new Uint8Array(p.bytes) } : null;
  }

  async list(): Promise<readonly PhotoId[]> {
    // Only photo ids are ever stored here (trust boundary for the test double).
    return [...this.stored.keys()].map((id) => id as PhotoId);
  }

  async trash(id: PhotoId): Promise<boolean> {
    return this.#toTrash(id);
  }

  async untrash(id: PhotoId): Promise<boolean> {
    const p = this.trashBin.get(id);
    if (!p) return false;
    this.trashBin.delete(id);
    this.stored.set(id, p);
    return true;
  }

  async trashed(): Promise<readonly TrashedPhoto[]> {
    return [...this.trashBin].map(([id, p]) => ({ id, name: `${id}.bin`, trashedAt: p.at }));
  }

  async purge(photo: TrashedPhoto): Promise<void> {
    this.trashBin.delete(photo.id);
  }

  async usage(): Promise<PhotoUsage> {
    return { photos: this.stored.size, bytes: [...this.stored.values()].reduce((t, p) => t + p.bytes.length, 0), trashed: this.trashBin.size };
  }

  async #toTrash(id: string): Promise<boolean> {
    const p = this.stored.get(id);
    if (!p) return false;
    this.stored.delete(id);
    this.trashBin.set(id, { ...p, at: this.now() });
    return true;
  }
}

/** A fixed set of photos the ledger refers to. */
export class MemoryLedgerPhotos implements LedgerPhotos {
  readonly ids = new Set<string>();

  async referenced(): Promise<ReadonlySet<string>> {
    return new Set(this.ids);
  }
}
