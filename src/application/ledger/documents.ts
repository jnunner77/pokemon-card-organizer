import { Binder, type BinderId } from '#domain/binders/binder.ts';
import { Card, type CardId } from '#domain/cards/card.ts';
import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import { type Collection, type Fields, isCollection } from '#domain/ledger/document.ts';
import type { LedgerEvent } from '#domain/ledger/events.ts';
import { documentId, type InvalidId } from '#domain/ledger/ids.ts';
import type { PocketHoldsAnotherCard } from '#domain/ledger/pockets.ts';
import { repageBinder } from '#domain/ledger/repage.ts';
import { Setting, type SettingId } from '#domain/settings/setting.ts';
import { pageMayWrite } from '#domain/settings/setting-fields.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { LedgerDeps } from './deps.ts';
import { checkPocket } from './pocket-check.ts';

// What the three document use cases (put, merge, delete) share: finding a binder, card or setting
// by its collection and id, whichever it is, and saving or deleting it. Saving a binder whose
// pockets per page changed moves its cards too, so they keep their order.

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
  /** Save it, and what changes with it (a binder's cards); the events of those others. */
  save(at: Date): Promise<Result<readonly LedgerEvent[], InvalidDocument | PocketHoldsAnotherCard>>;
  delete(): Promise<void>;
}

/** What else is saved (or checked) with a document, made when it is found (before it changes) or created (`fresh`). */
type Alongside<A> = (doc: A, fresh: boolean) => (at: Date) => Promise<Result<readonly LedgerEvent[], InvalidDocument | PocketHoldsAnotherCard>>;

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
      return ok({ collection, id: id.value, table: table(deps.cards, id.value, (doc, at) => Card.create(id.value, doc, at), cardPocket(deps)) });
    }
    case 'binders': {
      const id = documentId<BinderId>(rawId);
      if (!id.ok) return id;
      return ok({ collection, id: id.value, table: table(deps.binders, id.value, (doc, at) => Binder.create(id.value, doc, at), binderCards(deps)) });
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

/** A binder's cards, moved to keep their order when its pockets per page change. */
const binderCards =
  (deps: LedgerDeps): Alongside<Binder> =>
  (binder) => {
    const fromPockets = binder.pocketsPerPage;
    return async (at) => {
      const cards = (await deps.cards.all()).filter((c) => c.place.binderId === binder.id);
      const moved = repageBinder(binder, cards, fromPockets, at);
      if (!moved.ok) return moved;
      for (const card of moved.value) await deps.cards.save(card);
      return ok(moved.value.flatMap((c) => c.pullEvents()));
    };
  };

/** A card that is new or moved must fit its pocket: a pocket only holds copies of one card. */
const cardPocket =
  (deps: LedgerDeps): Alongside<Card> =>
  (card, fresh) => {
    const before = fresh ? null : card.place;
    return async () => {
      const fits = await checkPocket(deps.cards, card, before);
      return fits.ok ? ok([]) : fits;
    };
  };

const nothingElse = () => async () => ok([]);

function table<A extends LedgerDocument, I>(repo: Repository<A, I>, id: I, create: (doc: unknown, at: Date) => Result<A, InvalidDocument>, alongside: Alongside<A> = nothingElse): DocumentTable {
  const held = (doc: A, fresh: boolean): Held => {
    const others = alongside(doc, fresh);
    return {
      doc,
      save: async (at) => {
        const saved = await others(at);
        if (saved.ok) await repo.save(doc);
        return saved;
      },
      delete: () => repo.delete(doc),
    };
  };
  return {
    find: async () => {
      const found = await repo.findById(id);
      return found ? held(found, false) : undefined;
    },
    create: (doc, at) => {
      const made = create(doc, at);
      return made.ok ? ok(held(made.value, true)) : made;
    },
  };
}
