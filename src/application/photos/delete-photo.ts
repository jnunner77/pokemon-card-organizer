import { isPhotoId } from '#domain/photos/photo.ts';
import type { LedgerPhotos, PhotoStore } from './ports.ts';

/** Move a photo to the trash, unless a card still shows it (whatever the page thought). */
export class DeletePhoto {
  readonly #deps: { readonly photos: PhotoStore; readonly ledgerPhotos: LedgerPhotos };

  constructor(deps: { readonly photos: PhotoStore; readonly ledgerPhotos: LedgerPhotos }) {
    this.#deps = deps;
  }

  async execute(input: { readonly id: string }): Promise<void> {
    const { id } = input;
    if (!isPhotoId(id)) return;
    if ((await this.#deps.ledgerPhotos.referenced()).has(id)) return;
    await this.#deps.photos.trash(id);
  }
}
