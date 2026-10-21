import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { MAX_PAGE } from '../cards/card-fields.ts';
import type { InvalidDocument } from '../ledger/check-document.ts';
import { type Fields, isRecord } from '../ledger/document.ts';
import type { LedgerEvent } from '../ledger/events.ts';
import { mergedFields, replacedFields } from '../ledger/fields-state.ts';

export type BinderId = Brand<string, 'BinderId'>;

export interface BinderSnapshot {
  readonly id: BinderId;
  readonly fields: Fields;
}

/** A card's pocket kept in a binder's saved layout. */
export interface LayoutPlace {
  readonly id: string;
  readonly page: number;
  readonly slot: number;
}

/** The page sizes a binder can have; anything else is treated as the usual 9. */
export const PAGE_SIZES: readonly number[] = [4, 9, 12, 16];
export const DEFAULT_PAGE_SIZE = 9;

/** A binder of pages and pockets, or a display case holding cards with no page or pocket. */
export class Binder {
  readonly #id: BinderId;
  #fields: Fields;
  #events: LedgerEvent[] = [];

  private constructor(id: BinderId, fields: Fields) {
    this.#id = id;
    this.#fields = fields;
  }

  static create(id: BinderId, doc: unknown, at: Date): Result<Binder, InvalidDocument> {
    const fields = replacedFields('binders', doc);
    if (!fields.ok) return fields;
    const binder = new Binder(id, fields.value);
    binder.#saved(at);
    return ok(binder);
  }

  static reconstitute(snapshot: BinderSnapshot): Binder {
    return new Binder(snapshot.id, snapshot.fields);
  }

  get id(): BinderId {
    return this.#id;
  }

  get fields(): Fields {
    return this.#fields;
  }

  get name(): string | null {
    const name = this.#fields['name'];
    return typeof name === 'string' ? name : null;
  }

  get isCase(): boolean {
    return this.#fields['kind'] === 'case';
  }

  get pocketsPerPage(): number {
    const pockets = this.#fields['pockets'];
    return typeof pockets === 'number' && PAGE_SIZES.includes(pockets) ? pockets : DEFAULT_PAGE_SIZE;
  }

  /** Whether a card can sit in this pocket of the binder's pages. */
  fits(page: unknown, slot: unknown): boolean {
    const within = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
    return within(page, MAX_PAGE) && within(slot, this.pocketsPerPage);
  }

  replace(doc: unknown, at: Date): Result<void, InvalidDocument> {
    return this.#apply(replacedFields('binders', doc), at);
  }

  merge(patch: unknown, at: Date): Result<void, InvalidDocument> {
    return this.#apply(mergedFields('binders', this.#fields, patch), at);
  }

  /** Keep where its cards are now, so the page can put them back after sorting by release date or price. */
  saveLayout(places: readonly LayoutPlace[], at: Date): Result<void, InvalidDocument> {
    return this.merge({ layout: { savedAt: at.toISOString(), places } }, at);
  }

  /** The pockets kept in its saved layout (none when it has no layout). */
  get layoutPlaces(): readonly LayoutPlace[] {
    const layout = this.#fields['layout'];
    if (!isRecord(layout) || !Array.isArray(layout['places'])) return [];
    const places: LayoutPlace[] = [];
    for (const p of layout['places']) {
      if (isRecord(p) && typeof p['id'] === 'string' && typeof p['page'] === 'number' && typeof p['slot'] === 'number') places.push({ id: p['id'], page: p['page'], slot: p['slot'] });
    }
    return places;
  }

  /** Move the saved layout's pockets (its page size changed), keeping when it was saved. */
  moveLayout(places: readonly LayoutPlace[], at: Date): Result<void, InvalidDocument> {
    const layout = this.#fields['layout'];
    if (!isRecord(layout)) return ok(undefined);
    return this.merge({ layout: { ...layout, places } }, at);
  }

  delete(at: Date): void {
    this.#events.push({ type: 'DocumentDeleted', collection: 'binders', id: this.#id, occurredAt: at });
  }

  pullEvents(): readonly LedgerEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): BinderSnapshot {
    return { id: this.#id, fields: this.#fields };
  }

  #apply(next: Result<Fields, InvalidDocument>, at: Date): Result<void, InvalidDocument> {
    if (!next.ok) return err(next.error);
    this.#fields = next.value;
    this.#saved(at);
    return ok(undefined);
  }

  #saved(at: Date) {
    this.#events.push({ type: 'DocumentSaved', collection: 'binders', id: this.#id, occurredAt: at });
  }
}
