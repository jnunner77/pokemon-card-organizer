import { Binder, type BinderId } from '#domain/binders/binder.ts';
import { Card, type CardId } from '#domain/cards/card.ts';
import { placeholderCards } from '#domain/catalog/master-sets.ts';
import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import { documentId, type InvalidId } from '#domain/ledger/ids.ts';
import { ok, type Result } from '#shared/result.ts';
import { commit } from '../ledger/commit.ts';
import type { CatalogDeps } from './deps.ts';
import { MasterSetFinder } from './master-set-finder.ts';
import { findMasterSet, type MasterSetError } from './preview-master-set.ts';

export interface CreateMasterSetInput {
  /** Who is making it, for the log. */
  readonly actor: string;
  /** The set, by name or id. */
  readonly set: string;
  /** Who is collecting it: the binder and its cards are theirs. */
  readonly owner: string;
  /** The binder's name. */
  readonly name: string;
  readonly color: string | null;
  readonly pockets: number;
  /** Promo printings too (stamps, Cosmos holos): left out unless asked for. */
  readonly extras: boolean;
}

export interface CreatedMasterSet {
  readonly binderId: string;
  readonly cards: number;
  readonly pages: number;
}

export type CreateMasterSetError = MasterSetError | InvalidDocument | InvalidId;

/**
 * A master set made: a new binder holding one placeholder per variant, filling its pages from page
 * 1, pocket 1, owned by whoever is collecting it. Every card is checked before anything is saved
 * (an owner the ledger doesn't know, say): the binder and its cards are saved together, or not at all.
 */
export class CreateMasterSet {
  readonly #deps: Pick<CatalogDeps, 'binders' | 'cards' | 'unitOfWork' | 'events' | 'clock' | 'ids' | 'activity'>;
  readonly #finder: MasterSetFinder;

  constructor(deps: Pick<CatalogDeps, 'database' | 'tcgplayer' | 'binders' | 'cards' | 'unitOfWork' | 'events' | 'clock' | 'ids' | 'activity'>) {
    this.#deps = deps;
    this.#finder = new MasterSetFinder(deps);
  }

  async execute(input: CreateMasterSetInput): Promise<Result<CreatedMasterSet, CreateMasterSetError>> {
    const deps = this.#deps;
    const found = await findMasterSet(this.#finder, input.set);
    if (!found.ok) return found;
    const master = found.value;
    const entries = master.entries.filter((e) => input.extras || !e.extra);
    const now = deps.clock.now();
    const at = now.toISOString();
    const binderId = documentId<BinderId>(deps.ids.next());
    if (!binderId.ok) return binderId;
    const made = await commit<CreatedMasterSet, CreateMasterSetError>(deps, async () => {
      const order = Math.max(0, ...(await deps.binders.all()).map((b) => Number(b.fields['order']) || 0)) + 1;
      const cards: Card[] = [];
      for (const doc of placeholderCards(entries, { binderId: binderId.value, pockets: input.pockets, owner: input.owner, now: at })) {
        const id = documentId<CardId>(deps.ids.next());
        if (!id.ok) return id;
        const card = Card.create(id.value, doc, now);
        if (!card.ok) return card;
        cards.push(card.value);
      }
      // The binder keeps its owner, so cards added to it later start as theirs too.
      const binder = Binder.create(binderId.value, { name: input.name, color: input.color, pockets: input.pockets, kind: 'binder', owner: input.owner, order, createdAt: at }, now);
      if (!binder.ok) return binder;
      await deps.binders.save(binder.value);
      for (const card of cards) await deps.cards.save(card);
      return ok({
        value: { binderId: binderId.value, cards: cards.length, pages: Math.ceil(cards.length / input.pockets) },
        events: [...binder.value.pullEvents(), ...cards.flatMap((c) => c.pullEvents())],
      });
    });
    if (!made.ok) return made;
    const { tcgplayer } = master;
    deps.activity.info(`${input.actor} made a ${master.title} master set: ${input.name}, ${made.value.cards} placeholders (${master.cards} cards${tcgplayer.checked ? `, ${tcgplayer.added} printings from TCGplayer` : ''})`);
    return made;
  }
}
