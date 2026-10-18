import fs from 'node:fs';
import type { PhotoFile, PhotoStore, PhotoUsage } from '#application/photos/ports.ts';
import type { PhotoId, PhotoType } from '#domain/photos/photo.ts';
import type { TrashedPhoto } from '#domain/photos/trash.ts';
import type { PhotoFiles } from './photo-files.ts';

/** The photo store port over the photo files in the data directory. */
export class FilePhotoStore implements PhotoStore {
  readonly #files: PhotoFiles;

  constructor(files: PhotoFiles) {
    this.#files = files;
  }

  async save(id: PhotoId, _type: PhotoType, bytes: Uint8Array): Promise<void> {
    if (!this.#files.put(bytes, id)) throw new Error(`The photo ${id} couldn't be stored`);
  }

  async has(id: PhotoId): Promise<boolean> {
    return this.#files.find(id) !== null;
  }

  async open(id: PhotoId): Promise<PhotoFile | null> {
    const hit = this.#files.find(id);
    if (!hit) return null;
    const stat = fs.statSync(hit.file);
    return { type: hit.type, bytes: stat.size, modifiedAt: stat.mtime, content: fs.createReadStream(hit.file) };
  }

  async read(id: PhotoId): Promise<{ type: PhotoType; bytes: Uint8Array } | null> {
    const hit = this.#files.find(id);
    return hit ? { type: hit.type, bytes: fs.readFileSync(hit.file) } : null;
  }

  async list(): Promise<readonly PhotoId[]> {
    // The file names were checked against the photo id pattern (trust boundary).
    return this.#files.list().map((id) => id as PhotoId);
  }

  async trash(id: PhotoId): Promise<boolean> {
    return this.#files.remove(id);
  }

  async untrash(id: PhotoId): Promise<boolean> {
    return this.#files.untrash(id);
  }

  async trashed(): Promise<readonly TrashedPhoto[]> {
    return this.#files.trashed();
  }

  async purge(photo: TrashedPhoto): Promise<void> {
    this.#files.purge(photo.name);
  }

  async usage(): Promise<PhotoUsage> {
    return this.#files.usage();
  }
}
