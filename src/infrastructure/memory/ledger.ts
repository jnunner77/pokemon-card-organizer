import type { LedgerReader, LedgerView } from '#application/ledger/ledger-reader.ts';
import type { UnitOfWork } from '#application/ports.ts';
import { Binder, type BinderId } from '#domain/binders/binder.ts';
import type { BinderRepository } from '#domain/binders/repository.ts';
import { Card, type CardId } from '#domain/cards/card.ts';
import type { CardRepository } from '#domain/cards/repository.ts';
import { COLLECTIONS, type Collection, type Fields } from '#domain/ledger/document.ts';
import type { SettingRepository } from '#domain/settings/repository.ts';
import { Setting, type SettingId } from '#domain/settings/setting.ts';
import type { Result } from '#shared/result.ts';

// The ledger in memory, for application tests. Repositories keep copies of snapshots (never the
// aggregates themselves), which catches mapping mistakes and shared objects.

type Tables = Record<Collection, Map<string, Fields>>;

export class MemoryLedger {
  readonly tables: Tables = { binders: new Map(), cards: new Map(), settings: new Map() };
  /** Every unit of work run, for assertions: whether it was kept. */
  readonly runs: { committed: boolean }[] = [];

  readonly cards: CardRepository = new MemoryDocuments<CardId, Card>(this.tables.cards, Card.reconstitute, (id) => id as CardId);
  readonly binders: BinderRepository = new MemoryDocuments<BinderId, Binder>(this.tables.binders, Binder.reconstitute, (id) => id as BinderId);
  readonly settings: SettingRepository = new MemoryDocuments<SettingId, Setting>(this.tables.settings, Setting.reconstitute, (id) => id as SettingId);

  readonly reader: LedgerReader = {
    read: async (): Promise<LedgerView> => {
      const list = (c: Collection) => [...this.tables[c]].map(([id, fields]) => ({ id, ...structuredClone(fields) }));
      return { binders: list('binders'), cards: list('cards'), settings: list('settings') };
    },
  };

  /** All or nothing: the tables are put back as they were if the work fails or throws. */
  readonly unitOfWork: UnitOfWork = {
    run: async <T, E>(work: () => Promise<Result<T, E>>): Promise<Result<T, E>> => {
      const before = structuredClone(this.tables);
      const rollback = () => {
        for (const c of COLLECTIONS) {
          this.tables[c].clear();
          for (const [id, fields] of before[c]) this.tables[c].set(id, fields);
        }
      };
      let result: Result<T, E>;
      try {
        result = await work();
      } catch (error) {
        rollback();
        this.runs.push({ committed: false });
        throw error;
      }
      if (!result.ok) rollback();
      this.runs.push({ committed: result.ok });
      return result;
    },
  };

  /** Put a document straight in, as test setup. */
  seed(collection: Collection, id: string, fields: Fields): void {
    this.tables[collection].set(id, structuredClone(fields));
  }
}

interface Stored<I extends string> {
  readonly id: I;
  toSnapshot(): { readonly id: I; readonly fields: Fields };
}

class MemoryDocuments<I extends string, A extends Stored<I>> {
  readonly #table: Map<string, Fields>;
  readonly #reconstitute: (snapshot: { id: I; fields: Fields }) => A;
  readonly #asId: (id: string) => I;

  constructor(table: Map<string, Fields>, reconstitute: (snapshot: { id: I; fields: Fields }) => A, asId: (id: string) => I) {
    this.#table = table;
    this.#reconstitute = reconstitute;
    this.#asId = asId;
  }

  async findById(id: I): Promise<A | undefined> {
    const fields = this.#table.get(id);
    return fields ? this.#reconstitute({ id, fields: structuredClone(fields) }) : undefined;
  }

  async all(): Promise<readonly A[]> {
    return [...this.#table].map(([id, fields]) => this.#reconstitute({ id: this.#asId(id), fields: structuredClone(fields) }));
  }

  async save(doc: A): Promise<void> {
    const { id, fields } = doc.toSnapshot();
    this.#table.set(id, structuredClone(fields));
  }

  async delete(doc: A): Promise<void> {
    this.#table.delete(doc.id);
  }
}
