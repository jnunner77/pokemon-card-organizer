import { isPhotoId } from '#domain/photos/photo.ts';
import type { PhotoFile, PhotoStore } from './ports.ts';

/** A stored photo to show, or null when there is none with that id. */
export class OpenPhoto {
  readonly #deps: { readonly photos: PhotoStore };

  constructor(deps: { readonly photos: PhotoStore }) {
    this.#deps = deps;
  }

  async execute(input: { readonly id: string }): Promise<PhotoFile | null> {
    return isPhotoId(input.id) ? this.#deps.photos.open(input.id) : null;
  }
}
