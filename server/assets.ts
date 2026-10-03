import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Card photos, one file each under <data>/assets, named <id>.<ext>. Ids are random and a
// photo is never changed in place (a new photo gets a new id), so browsers may cache
// them forever.

export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' } as const;
export type ImageType = keyof typeof IMAGE_TYPES;
const EXT_TYPES = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])) as Record<string, ImageType>;

/** Largest photo accepted: phones' originals are stored as-is when the page can't shrink them. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const assetIdSchema = /^[a-f0-9]{32}$/;

/** Work out the image type from the file's first bytes, not from what the browser claimed. */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Days a deleted photo is kept: longer than the oldest (monthly) copy of the ledger. */
export const TRASH_DAYS = 400;

export class Assets {
  readonly dir: string;
  readonly trash: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'assets');
    this.trash = path.join(this.dir, '.trash');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Store a photo. Returns null when the bytes aren't a supported image. */
  put(buf: Buffer, id: string = crypto.randomBytes(16).toString('hex')): { id: string; type: ImageType } | null {
    const type = sniffImage(buf);
    if (!type || !assetIdSchema.test(id)) return null;
    this.remove(id);
    const file = path.join(this.dir, `${id}.${IMAGE_TYPES[type]}`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    return { id, type };
  }

  find(id: string): { file: string; type: ImageType } | null {
    if (!assetIdSchema.test(id)) return null;
    for (const [ext, type] of Object.entries(EXT_TYPES)) {
      const file = path.join(this.dir, `${id}.${ext}`);
      if (fs.existsSync(file)) return { file, type };
    }
    return null;
  }

  /**
   * Move a photo to the trash folder. It stays there for TRASH_DAYS, longer than the daily
   * copies of the ledger are kept, so restoring a copy can bring it back.
   */
  remove(id: string) {
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
  untrash(id: string) {
    if (!assetIdSchema.test(id) || !fs.existsSync(this.trash)) return false;
    const f = fs.readdirSync(this.trash).find((n) => n.startsWith(id + '.'));
    if (!f) return false;
    fs.renameSync(path.join(this.trash, f), path.join(this.dir, f));
    return true;
  }

  /** Delete trashed photos older than TRASH_DAYS. */
  purgeTrash(now = Date.now()) {
    if (!fs.existsSync(this.trash)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(this.trash)) {
      const p = path.join(this.trash, f);
      if (now - fs.statSync(p).mtimeMs > TRASH_DAYS * 86_400_000) {
        fs.rmSync(p, { force: true });
        n++;
      }
    }
    return n;
  }

  /** Files and bytes in use, for the Checks page. */
  usage() {
    let bytes = 0;
    const ids = this.list();
    for (const id of ids) bytes += fs.statSync(this.find(id)!.file).size;
    return { photos: ids.length, bytes, trashed: fs.existsSync(this.trash) ? fs.readdirSync(this.trash).length : 0 };
  }

  list(): string[] {
    return fs
      .readdirSync(this.dir)
      .map((f) => /^([a-f0-9]{32})\.(jpg|png|webp|gif)$/.exec(f)?.[1])
      .filter((id): id is string => !!id);
  }
}
