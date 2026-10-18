import type { BinderId } from '#domain/binders/binder.ts';
import { arrangeBinder, type ArrangeError, type PocketMove } from '#domain/ledger/arrange.ts';
import { documentId } from '#domain/ledger/ids.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { commit } from './commit.ts';
import type { LedgerDeps } from './deps.ts';

export interface ArrangeBinderInput {
  /** Who is sorting it, for the activity log. */
  readonly actor: string;
  readonly binderId: string;
  /** Where each card goes, or null when the request didn't say in a readable way. */
  readonly arrangement: { readonly moves: readonly PocketMove[]; readonly saveLayout: boolean } | null;
}

export interface ArrangeBinderOutput {
  readonly moved: number;
  readonly cards: number;
  readonly layoutSaved: number | null;
}

/** A binder that's gone is reported first, then an arrangement that couldn't be read. */
export type ArrangeBinderError = { readonly code: 'BINDER_NOT_FOUND' } | { readonly code: 'ARRANGEMENT_UNREADABLE' } | ArrangeError;

/** Sort a binder: every card in it to its new pocket, all at once. */
export class ArrangeBinder {
  readonly #deps: LedgerDeps;

  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  async execute(input: ArrangeBinderInput): Promise<Result<ArrangeBinderOutput, ArrangeBinderError>> {
    const id = documentId<BinderId>(input.binderId);
    if (!id.ok) return err({ code: 'BINDER_NOT_FOUND' });
    const now = this.#deps.clock.now();
    const done = await commit<ArrangeBinderOutput & { readonly name: string | null }, ArrangeBinderError>(this.#deps, async () => {
      const binder = await this.#deps.binders.findById(id.value);
      if (!binder) return err({ code: 'BINDER_NOT_FOUND' });
      const { arrangement } = input;
      if (!arrangement) return err({ code: 'ARRANGEMENT_UNREADABLE' });
      const inBinder = (await this.#deps.cards.all()).filter((c) => c.place.binderId === binder.id);
      const arranged = arrangeBinder(binder, inBinder, arrangement.moves, { saveLayout: arrangement.saveLayout, at: now });
      if (!arranged.ok) return arranged;
      for (const card of arranged.value.moved) await this.#deps.cards.save(card);
      if (arranged.value.layoutSaved !== null) await this.#deps.binders.save(binder);
      const events = [...arranged.value.moved.flatMap((c) => c.pullEvents()), ...binder.pullEvents()];
      const value = { name: binder.name, moved: arranged.value.moved.length, cards: arrangement.moves.length, layoutSaved: arranged.value.layoutSaved };
      return ok({ value, events });
    });
    if (!done.ok) return done;
    const { name, ...out } = done.value;
    this.#deps.activity.info(`${input.actor} sorted ${name ?? 'a binder'}: ${out.moved} of ${out.cards} cards moved${out.layoutSaved !== null ? ', layout saved' : ''}`);
    return ok(out);
  }
}
