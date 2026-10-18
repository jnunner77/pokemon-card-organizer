import { checkPhoto, type PhotoError, type PhotoId, type PhotoType } from '#domain/photos/photo.ts';
import { ok, type Result } from '#shared/result.ts';
import type { IdGenerator } from '../ports.ts';
import type { PhotoStore } from './ports.ts';

/** Store a photo the page sent, under a new random id. */
export class UploadPhoto {
  readonly #deps: { readonly photos: PhotoStore; readonly ids: IdGenerator };

  constructor(deps: { readonly photos: PhotoStore; readonly ids: IdGenerator }) {
    this.#deps = deps;
  }

  async execute(input: { readonly bytes: Uint8Array }): Promise<Result<{ readonly id: PhotoId; readonly type: PhotoType }, PhotoError>> {
    const type = checkPhoto(input.bytes);
    if (!type.ok) return type;
    // The id generator's random ids are photo ids (trust boundary).
    const id = this.#deps.ids.next() as PhotoId;
    await this.#deps.photos.save(id, input.bytes);
    return ok({ id, type: type.value });
  }
}
