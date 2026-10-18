import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import type { Collection } from '#domain/ledger/document.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';
import { address, type AddressError } from './documents.ts';
import { type DocumentView, viewOf } from './ledger-reader.ts';

export interface MergeDocumentInput {
  readonly collection: string;
  readonly id: string;
  /** The fields that change; the others stay as they are. */
  readonly patch: unknown;
}

export type MergeDocumentError = AddressError | InvalidDocument | { readonly code: 'DOCUMENT_NOT_FOUND'; readonly collection: Collection; readonly id: string };

/** Change some fields of a binder, card or setting. */
export class MergeDocument {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(input: MergeDocumentInput): Promise<Result<DocumentView, MergeDocumentError>> {
    const at = address(this.#deps, input.collection, input.id);
    if (!at.ok) return at;
    const { collection, id, table } = at.value;
    const now = this.#deps.clock.now();
    return commit<DocumentView, MergeDocumentError>(this.#deps, async () => {
      const found = await table.find();
      if (!found) return err({ code: 'DOCUMENT_NOT_FOUND', collection, id });
      const merged = found.doc.merge(input.patch, now);
      if (!merged.ok) return merged;
      await found.save();
      return ok({ value: viewOf(found.doc.id, found.doc.fields), events: found.doc.pullEvents() });
    });
  }
}
