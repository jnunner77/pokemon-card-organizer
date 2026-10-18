import { Binder, type BinderId } from '#domain/binders/binder.ts';
import { Card, type CardId } from '#domain/cards/card.ts';
import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import { type Collection, type Fields, isCollection } from '#domain/ledger/document.ts';
import type { LedgerEvent } from '#domain/ledger/events.ts';
import { documentId, type InvalidId } from '#domain/ledger/ids.ts';
import { Setting, type SettingId } from '#domain/settings/setting.ts';
import { pageMayWrite } from '#domain/settings/setting-fields.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { LedgerDeps } from './deps.ts';

// What the three document use cases (put, merge, delete) share: finding a binder, card or setting
// by its collection and id, whichever it is, and saving or deleting it.

export type AddressError = { readonly code: 'NO_SUCH_COLLECTION' } | InvalidId | { readonly code: 'SETTING_BELONGS_TO_SERVER' };

/** A binder, card or setting, whichever the address names. */
export interface LedgerDocument {
  readonly id: string;
  readonly fields: Fields;
  replace(doc: unknown, at: Date): Result<void, InvalidDocument>;
  merge(patch: unknown, at: Date): Result<void, InvalidDocument>;
  delete(at: Date): void;
  pullEvents(): readonly LedgerEvent[];
}

/** A document found or just made, with how to save or delete it. */
export interface Held {
  readonly doc: LedgerDocument;
  save(): Promise<void>;
  delete(): Promise<void>;
}

export interface DocumentTable {
  find(): Promise<Held | undefined>;
  create(doc: unknown, at: Date): Result<Held, InvalidDocument>;
}

export interface Address {
  readonly collection: Collection;
  readonly id: string;
  readonly table: DocumentTable;
}

/** Check the collection and id the page sent, and that the page may write there. */
export function address(deps: LedgerDeps, collection: string, rawId: string): Result<Address, AddressError> {
  if (!isCollection(collection)) return err({ code: 'NO_SUCH_COLLECTION' });
  switch (collection) {
    case 'cards': {
      const id = documentId<CardId>(rawId);
      if (!id.ok) return id;
      return ok({ collection, id: id.value, table: table(deps.cards, id.value, (doc, at) => Card.create(id.value, doc, at)) });
    }
    case 'binders': {
      const id = documentId<BinderId>(rawId);
      if (!id.ok) return id;
      return ok({ collection, id: id.value, table: table(deps.binders, id.value, (doc, at) => Binder.create(id.value, doc, at)) });
    }
    case 'settings': {
      const id = documentId<SettingId>(rawId);
      if (!id.ok) return id;
      if (!pageMayWrite(id.value)) return err({ code: 'SETTING_BELONGS_TO_SERVER' });
      return ok({ collection, id: id.value, table: table(deps.settings, id.value, (doc, at) => Setting.create(id.value, doc, at)) });
    }
  }
}

interface Repository<A, I> {
  findById(id: I): Promise<A | undefined>;
  save(doc: A): Promise<void>;
  delete(doc: A): Promise<void>;
}

function table<A extends LedgerDocument, I>(repo: Repository<A, I>, id: I, create: (doc: unknown, at: Date) => Result<A, InvalidDocument>): DocumentTable {
  const held = (doc: A): Held => ({ doc, save: () => repo.save(doc), delete: () => repo.delete(doc) });
  return {
    find: async () => {
      const found = await repo.findById(id);
      return found ? held(found) : undefined;
    },
    create: (doc, at) => {
      const made = create(doc, at);
      return made.ok ? ok(held(made.value)) : made;
    },
  };
}
