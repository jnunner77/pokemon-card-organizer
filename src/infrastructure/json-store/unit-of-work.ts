import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnitOfWork } from '#application/ports.ts';
import type { Result } from '#shared/result.ts';
import { Session } from './session.ts';
import type { Store } from './store.ts';

/** Gives repositories the session of the unit of work they are running in. */
export interface CurrentSession {
  current(): Session;
}

/** How many times a unit of work is tried again when the ledger changed while it ran. */
const ATTEMPTS = 5;

/**
 * A unit of work over the JSON store: the work runs against a session (the ledger with its own
 * changes on top), which is saved and sent to open pages as one change only if the work succeeds.
 * Units of work run one at a time; if the ledger changed meanwhile anyway (the daily price update
 * still writes to the store directly), the work runs again on the ledger as it is now, so
 * nothing anyone else saved is lost.
 */
export class StoreUnitOfWork implements UnitOfWork, CurrentSession {
  readonly #store: Store;
  readonly #context = new AsyncLocalStorage<Session>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: Store) {
    this.#store = store;
  }

  run<T, E>(work: () => Promise<Result<T, E>>): Promise<Result<T, E>> {
    // Waiting for our own unit of work to finish would never end.
    if (this.#context.getStore()) throw new Error('A unit of work is already running here; they cannot be nested');
    const next = this.#queue.then(() => this.#attempt(work));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  current(): Session {
    const session = this.#context.getStore();
    if (!session) throw new Error('A repository was used outside a unit of work');
    return session;
  }

  async #attempt<T, E>(work: () => Promise<Result<T, E>>): Promise<Result<T, E>> {
    for (let attempt = 1; ; attempt++) {
      const session = new Session(this.#store);
      const result = await this.#context.run(session, work);
      if (!result.ok) return result;
      if (session.startedAt !== this.#store.version) {
        if (attempt < ATTEMPTS) continue;
        throw new Error('The ledger kept changing while a change was being made; try again');
      }
      this.#store.transact(session.changes());
      return result;
    }
  }
}
