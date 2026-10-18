import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';

// Card photos: the person's own pictures and the official ones the daily update downloads. Each
// is stored once under a random id and never changed in place (a new photo gets a new id), so
// browsers may cache them forever.

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];
/** Each type's file extension. */
export const EXTENSIONS: Readonly<Record<PhotoType, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

export type PhotoId = Brand<string, 'PhotoId'>;
export const PHOTO_ID = /^[a-f0-9]{32}$/;
export const isPhotoId = (value: unknown): value is PhotoId => typeof value === 'string' && PHOTO_ID.test(value);

/** Largest photo accepted: phones' originals are stored as-is when the page can't shrink them. */
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

export type PhotoError = { readonly code: 'PHOTO_EMPTY' } | { readonly code: 'NOT_A_PICTURE' };

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) => bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The picture's type from its first bytes, never from what the browser claimed. */
export function photoType(bytes: Uint8Array): PhotoType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

/** A photo can be stored when it has bytes and they are a JPG, PNG, WebP or GIF picture. */
export function checkPhoto(bytes: Uint8Array): Result<PhotoType, PhotoError> {
  if (!bytes.length) return err({ code: 'PHOTO_EMPTY' });
  const type = photoType(bytes);
  return type ? ok(type) : err({ code: 'NOT_A_PICTURE' });
}

/** The type a stored photo's file extension stands for. */
export const typeOfExtension = (ext: string): PhotoType | null => PHOTO_TYPES.find((t) => EXTENSIONS[t] === ext) ?? null;
