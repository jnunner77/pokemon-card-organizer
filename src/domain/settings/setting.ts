import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { InvalidDocument } from '../ledger/check-document.ts';
import type { Fields } from '../ledger/document.ts';
import type { LedgerEvent } from '../ledger/events.ts';
import { mergedFields, replacedFields } from '../ledger/fields-state.ts';

export type SettingId = Brand<string, 'SettingId'>;

export interface SettingSnapshot {
  readonly id: SettingId;
  readonly fields: Fields;
}

/** A settings document: the page's own (main: the exchange rate) or one of the server's. */
export class Setting {
  readonly #id: SettingId;
  #fields: Fields;
  #events: LedgerEvent[] = [];

  private constructor(id: SettingId, fields: Fields) {
    this.#id = id;
    this.#fields = fields;
  }

  static create(id: SettingId, doc: unknown, at: Date): Result<Setting, InvalidDocument> {
    const fields = replacedFields('settings', doc);
    if (!fields.ok) return fields;
    const setting = new Setting(id, fields.value);
    setting.#saved(at);
    return ok(setting);
  }

  static reconstitute(snapshot: SettingSnapshot): Setting {
    return new Setting(snapshot.id, snapshot.fields);
  }

  get id(): SettingId {
    return this.#id;
  }

  get fields(): Fields {
    return this.#fields;
  }

  replace(doc: unknown, at: Date): Result<void, InvalidDocument> {
    return this.#apply(replacedFields('settings', doc), at);
  }

  merge(patch: unknown, at: Date): Result<void, InvalidDocument> {
    return this.#apply(mergedFields('settings', this.#fields, patch), at);
  }

  delete(at: Date): void {
    this.#events.push({ type: 'DocumentDeleted', collection: 'settings', id: this.#id, occurredAt: at });
  }

  pullEvents(): readonly LedgerEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): SettingSnapshot {
    return { id: this.#id, fields: this.#fields };
  }

  #apply(next: Result<Fields, InvalidDocument>, at: Date): Result<void, InvalidDocument> {
    if (!next.ok) return err(next.error);
    this.#fields = next.value;
    this.#saved(at);
    return ok(undefined);
  }

  #saved(at: Date) {
    this.#events.push({ type: 'DocumentSaved', collection: 'settings', id: this.#id, occurredAt: at });
  }
}
