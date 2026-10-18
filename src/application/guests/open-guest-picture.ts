import { isListed, shownImage } from '#domain/guests/guest-card.ts';
import { isDocumentId } from '#domain/ledger/ids.ts';
import { isPhotoId } from '#domain/photos/photo.ts';
import type { PhotoFile } from '../photos/ports.ts';
import type { GuestDeps } from './deps.ts';

/** Photos saved before uploads were available are small data: URLs in the card itself. */
const INLINE = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/s;

export type GuestPicture = { readonly kind: 'inline'; readonly type: string; readonly bytes: Uint8Array } | { readonly kind: 'photo'; readonly photo: PhotoFile };

/** The picture of a card listed for sale, or null for any other card (or one without a picture). */
export class OpenGuestPicture {
  readonly #deps: Pick<GuestDeps, 'ledger' | 'photos' | 'base64'>;

  constructor(deps: Pick<GuestDeps, 'ledger' | 'photos' | 'base64'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly cardId: string }): Promise<GuestPicture | null> {
    if (!isDocumentId(input.cardId)) return null;
    const card = (await this.#deps.ledger.read()).cards.find((c) => c.id === input.cardId);
    const image = card && isListed(card) ? shownImage(card) : null;
    if (!image) return null;
    const inline = INLINE.exec(image);
    if (inline) return { kind: 'inline', type: inline[1] ?? 'image/jpeg', bytes: this.#deps.base64.decode(inline[2] ?? '') };
    if (!isPhotoId(image)) return null;
    const photo = await this.#deps.photos.open(image);
    return photo ? { kind: 'photo', photo } : null;
  }
}
