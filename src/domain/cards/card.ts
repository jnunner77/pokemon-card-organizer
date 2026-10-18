import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { InvalidDocument } from '../ledger/check-document.ts';
import type { Fields } from '../ledger/document.ts';
import type { LedgerEvent } from '../ledger/events.ts';
import { mergedFields, replacedFields } from '../ledger/fields-state.ts';
import { applyPriceEntries, checkPriceEntryFields, type PriceEntryChange, type PriceEntryError } from './price-entries.ts';

export type CardId = Brand<string, 'CardId'>;

export interface CardSnapshot {
  readonly id: CardId;
  readonly fields: Fields;
}

/** Where a card is: a binder's page and pocket, a display case (no page or pocket), or nowhere. */
export interface CardPlace {
  readonly binderId: string | null;
  readonly page: number | null;
  readonly slot: number | null;
}

export type CardError = InvalidDocument | PriceEntryError;

const numberOrNull = (v: unknown) => (typeof v === 'number' ? v : null);

/** One card in the collection: its details, where it is, its price log and sale. */
export class Card {
  readonly #id: CardId;
  #fields: Fields;
  #events: LedgerEvent[] = [];

  private constructor(id: CardId, fields: Fields) {
    this.#id = id;
    this.#fields = fields;
  }

  static create(id: CardId, doc: unknown, at: Date): Result<Card, InvalidDocument> {
    const fields = replacedFields('cards', doc);
    if (!fields.ok) return fields;
    const card = new Card(id, fields.value);
    card.#saved(at);
    return ok(card);
  }

  static reconstitute(snapshot: CardSnapshot): Card {
    return new Card(snapshot.id, snapshot.fields);
  }

  get id(): CardId {
    return this.#id;
  }

  get fields(): Fields {
    return this.#fields;
  }

  get place(): CardPlace {
    const binderId = this.#fields['binderId'];
    return { binderId: typeof binderId === 'string' ? binderId : null, page: numberOrNull(this.#fields['page']), slot: numberOrNull(this.#fields['slot']) };
  }

  /** The page saved the whole card. */
  replace(doc: unknown, at: Date): Result<void, InvalidDocument> {
    return this.#apply(replacedFields('cards', doc), at);
  }

  /** Some of its fields changed. */
  merge(patch: unknown, at: Date): Result<void, InvalidDocument> {
    return this.#apply(mergedFields('cards', this.#fields, patch), at);
  }

  /** Price entries added, changed or removed by id, with the fields that change with them. */
  changePriceEntries(change: PriceEntryChange, at: Date): Result<void, CardError> {
    const fieldsOk = checkPriceEntryFields(change.fields);
    if (!fieldsOk.ok) return fieldsOk;
    const prices = applyPriceEntries(this.#fields['prices'], change);
    if (!prices.ok) return prices;
    return this.merge({ ...change.fields, prices: prices.value }, at);
  }

  /** Put the card somewhere else (sorting a binder, moving cards); false when it is already there. */
  moveTo(place: CardPlace, at: Date): Result<boolean, InvalidDocument> {
    const now = this.place;
    if (now.binderId === place.binderId && now.page === place.page && now.slot === place.slot) return ok(false);
    const moved = this.merge({ binderId: place.binderId, page: place.page, slot: place.slot, updatedAt: at.toISOString() }, at);
    return moved.ok ? ok(true) : moved;
  }

  /** Put the card in another pocket of the binder it is in; false when it is already there. */
  moveWithinBinder(page: number, slot: number, at: Date): Result<boolean, InvalidDocument> {
    const now = this.place;
    if (now.page === page && now.slot === slot) return ok(false);
    const moved = this.merge({ page, slot, updatedAt: at.toISOString() }, at);
    return moved.ok ? ok(true) : moved;
  }

  delete(at: Date): void {
    this.#events.push({ type: 'DocumentDeleted', collection: 'cards', id: this.#id, occurredAt: at });
  }

  pullEvents(): readonly LedgerEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): CardSnapshot {
    return { id: this.#id, fields: this.#fields };
  }

  #apply(next: Result<Fields, InvalidDocument>, at: Date): Result<void, InvalidDocument> {
    if (!next.ok) return err(next.error);
    this.#fields = next.value;
    this.#saved(at);
    return ok(undefined);
  }

  #saved(at: Date) {
    this.#events.push({ type: 'DocumentSaved', collection: 'cards', id: this.#id, occurredAt: at });
  }
}
