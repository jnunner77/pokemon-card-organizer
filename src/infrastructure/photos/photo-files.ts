import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EXTENSIONS, isPhotoId, PHOTO_TYPES, type PhotoType, photoType } from '#domain/photos/photo.ts';
import type { TrashedPhoto } from '#domain/photos/trash.ts';

// Card photos, one file each under <data>/assets, named <id>.<ext>; deleted ones in
// <data>/assets/.trash (domain/photos/trash.ts says how long they stay). The Express code still
// uses these methods directly until its slices move; the layers use FilePhotoStore.

const FILE = /^([a-f0-9]{32})\.(jpg|png|webp|gif)$/;

export class PhotoFiles {
  readonly dir: string;
  readonly trash: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'assets');
    this.trash = path.join(this.dir, '.trash');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Store a photo (one already under that id goes to the trash). Null when the bytes aren't a supported picture. */
  put(bytes: Uint8Array, id: string = crypto.randomBytes(16).toString('hex')): { id: string; type: PhotoType } | null {
    const type = photoType(bytes);
    if (!type || !isPhotoId(id)) return null;
    this.remove(id);
    const file = path.join(this.dir, `${id}.${EXTENSIONS[type]}`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    return { id, type };
  }

  find(id: string): { file: string; type: PhotoType } | null {
    if (!isPhotoId(id)) return null;
    for (const type of PHOTO_TYPES) {
      const file = path.join(this.dir, `${id}.${EXTENSIONS[type]}`);
      if (fs.existsSync(file)) return { file, type };
    }
    return null;
  }

  /** Move a photo to the trash; false when there was none. */
  remove(id: string): boolean {
    const hit = this.find(id);
    if (!hit) return false;
    fs.mkdirSync(this.trash, { recursive: true });
    const dest = path.join(this.trash, path.basename(hit.file));
    fs.renameSync(hit.file, dest);
    const now = new Date();
    fs.utimesSync(dest, now, now);
    return true;
  }

  /** Bring a photo back from the trash. */
  untrash(id: string): boolean {
    if (!isPhotoId(id) || !fs.existsSync(this.trash)) return false;
    const f = fs.readdirSync(this.trash).find((n) => n.startsWith(`${id}.`));
    if (!f) return false;
    fs.renameSync(path.join(this.trash, f), path.join(this.dir, f));
    return true;
  }

  /** Every trashed photo and when it was trashed. */
  trashed(): TrashedPhoto[] {
    if (!fs.existsSync(this.trash)) return [];
    return fs.readdirSync(this.trash).map((name) => ({ id: name.replace(/\..*$/, ''), name, trashedAt: fs.statSync(path.join(this.trash, name)).mtime }));
  }

  /** Delete a trashed photo's file for good. */
  purge(name: string): void {
    fs.rmSync(path.join(this.trash, path.basename(name)), { force: true });
  }

  /** Files and bytes in use, for Administration. */
  usage(): { photos: number; bytes: number; trashed: number } {
    let bytes = 0;
    const ids = this.list();
    for (const id of ids) {
      const hit = this.find(id);
      if (hit) bytes += fs.statSync(hit.file).size;
    }
    return { photos: ids.length, bytes, trashed: fs.existsSync(this.trash) ? fs.readdirSync(this.trash).length : 0 };
  }

  list(): string[] {
    return fs
      .readdirSync(this.dir)
      .map((f) => FILE.exec(f)?.[1])
      .filter((id): id is string => !!id);
  }
}
