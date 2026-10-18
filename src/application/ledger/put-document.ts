import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import { ok, type Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';
import { address, type AddressError, type Held } from './documents.ts';
import { type DocumentView, viewOf } from './ledger-reader.ts';

export interface PutDocumentInput {
  readonly collection: string;
  readonly id: string;
  /** The whole document, as the page sent it. */
  readonly doc: unknown;
}

export type PutDocumentError = AddressError | InvalidDocument;

/** Create a binder, card or setting, or replace it whole. */
export class PutDocument {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(input: PutDocumentInput): Promise<Result<DocumentView, PutDocumentError>> {
    const at = address(this.#deps, input.collection, input.id);
    if (!at.ok) return at;
    const { table } = at.value;
    const now = this.#deps.clock.now();
    return commit<DocumentView, PutDocumentError>(this.#deps, async () => {
      let held: Held;
      const found = await table.find();
      if (found) {
        const replaced = found.doc.replace(input.doc, now);
        if (!replaced.ok) return replaced;
        held = found;
      } else {
        const made = table.create(input.doc, now);
        if (!made.ok) return made;
        held = made.value;
      }
      await held.save();
      return ok({ value: viewOf(held.doc.id, held.doc.fields), events: held.doc.pullEvents() });
    });
  }
}
