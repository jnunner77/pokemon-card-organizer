import type { PhotoId, PhotoType } from '#domain/photos/photo.ts';
import type { TrashedPhoto } from '#domain/photos/trash.ts';

/** A stored photo, ready to send. */
export interface PhotoFile {
  readonly type: PhotoType;
  readonly bytes: number;
  readonly modifiedAt: Date;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface PhotoUsage {
  readonly photos: number;
  readonly bytes: number;
  readonly trashed: number;
}

/** Where photos are kept, with a trash for deleted ones. */
export interface PhotoStore {
  /** Store a picture (checked already) under its id; one already there goes to the trash first. */
  save(id: PhotoId, bytes: Uint8Array): Promise<void>;
  has(id: PhotoId): Promise<boolean>;
  open(id: PhotoId): Promise<PhotoFile | null>;
  read(id: PhotoId): Promise<{ readonly type: PhotoType; readonly bytes: Uint8Array } | null>;
  list(): Promise<readonly PhotoId[]>;
  /** Move a photo to the trash; false when there was none. */
  trash(id: PhotoId): Promise<boolean>;
  /** Bring a photo back from the trash; false when it isn't there. */
  untrash(id: PhotoId): Promise<boolean>;
  trashed(): Promise<readonly TrashedPhoto[]>;
  /** Delete a trashed photo for good. */
  purge(photo: TrashedPhoto): Promise<void>;
  usage(): Promise<PhotoUsage>;
}

/** The photos the ledger refers to now. */
export interface LedgerPhotos {
  referenced(): Promise<ReadonlySet<string>>;
}
