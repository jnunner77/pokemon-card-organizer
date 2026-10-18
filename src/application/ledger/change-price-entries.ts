import type { CardId } from '#domain/cards/card.ts';
import { checkPriceEntryFields, type PriceEntry, type PriceEntryError } from '#domain/cards/price-entries.ts';
import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import type { Fields } from '#domain/ledger/document.ts';
import { documentId, type InvalidId } from '#domain/ledger/ids.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';
import { type DocumentView, viewOf } from './ledger-reader.ts';

export interface ChangePriceEntriesInput {
  readonly cardId: string;
  readonly add?: readonly PriceEntry[] | undefined;
  readonly update?: readonly PriceEntry[] | undefined;
  readonly remove?: readonly string[] | undefined;
  readonly fields?: Fields | undefined;
}

export type ChangePriceEntriesError = InvalidId | PriceEntryError | InvalidDocument | { readonly code: 'CARD_NOT_FOUND' };

/**
 * Add, change or remove a card's price entries by id, with other fields that change with them
 * (a sale's status and location), against the card as it is now.
 */
export class ChangePriceEntries {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(input: ChangePriceEntriesInput): Promise<Result<DocumentView, ChangePriceEntriesError>> {
    const id = documentId<CardId>(input.cardId);
    if (!id.ok) return id;
    const fieldsOk = checkPriceEntryFields(input.fields);
    if (!fieldsOk.ok) return fieldsOk;
    const now = this.#deps.clock.now();
    return commit<DocumentView, ChangePriceEntriesError>(this.#deps, async () => {
      const card = await this.#deps.cards.findById(id.value);
      if (!card) return err({ code: 'CARD_NOT_FOUND' });
      const changed = card.changePriceEntries({ add: input.add, update: input.update, remove: input.remove, fields: input.fields }, now);
      if (!changed.ok) return changed;
      await this.#deps.cards.save(card);
      return ok({ value: viewOf(card.id, card.fields), events: card.pullEvents() });
    });
  }
}
