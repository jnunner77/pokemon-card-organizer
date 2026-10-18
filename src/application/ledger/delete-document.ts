import { ok, type Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';
import { address, type AddressError } from './documents.ts';

export interface DeleteDocumentInput {
  readonly collection: string;
  readonly id: string;
}

/** Delete a binder, card or setting; one already gone is fine. */
export class DeleteDocument {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(input: DeleteDocumentInput): Promise<Result<void, AddressError>> {
    const at = address(this.#deps, input.collection, input.id);
    if (!at.ok) return at;
    const { table } = at.value;
    const now = this.#deps.clock.now();
    return commit<void, AddressError>(this.#deps, async () => {
      const found = await table.find();
      if (!found) return ok({ value: undefined, events: [] });
      found.doc.delete(now);
      await found.delete();
      return ok({ value: undefined, events: found.doc.pullEvents() });
    });
  }
}
