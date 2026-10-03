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

export class Assets {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'assets');
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

  remove(id: string) {
    const hit = this.find(id);
    if (hit) fs.rmSync(hit.file);
    return !!hit;
  }

  list(): string[] {
    return fs
      .readdirSync(this.dir)
      .map((f) => /^([a-f0-9]{32})\.(jpg|png|webp|gif)$/.exec(f)?.[1])
      .filter((id): id is string => !!id);
  }
}
