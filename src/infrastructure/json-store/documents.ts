import type { Collection, Fields } from '#domain/ledger/document.ts';
import type { CurrentSession } from './unit-of-work.ts';

/** The aggregates the ledger's repositories store: an id and fields, in and out. */
interface Stored<I extends string> {
  readonly id: I;
  toSnapshot(): { readonly id: I; readonly fields: Fields };
}

/** A repository for one collection of the ledger, read and written through the current unit of work. */
export class JsonDocuments<I extends string, A extends Stored<I>> {
  readonly #session: CurrentSession;
  readonly #collection: Collection;
  readonly #reconstitute: (snapshot: { id: I; fields: Fields }) => A;
  /** Ids come back out of the store exactly as they went in, checked by the domain. */
  readonly #asId: (id: string) => I;

  constructor(session: CurrentSession, collection: Collection, reconstitute: (snapshot: { id: I; fields: Fields }) => A, asId: (id: string) => I) {
    this.#session = session;
    this.#collection = collection;
    this.#reconstitute = reconstitute;
    this.#asId = asId;
  }

  async findById(id: I): Promise<A | undefined> {
    const fields = this.#session.current().get(this.#collection, id);
    return fields ? this.#reconstitute({ id, fields }) : undefined;
  }

  async all(): Promise<readonly A[]> {
    return this.#session
      .current()
      .all(this.#collection)
      .map(({ id, fields }) => this.#reconstitute({ id: this.#asId(id), fields }));
  }

  async save(doc: A): Promise<void> {
    const { id, fields } = doc.toSnapshot();
    this.#session.current().put(this.#collection, id, fields);
  }

  async delete(doc: A): Promise<void> {
    this.#session.current().remove(this.#collection, doc.id);
  }
}
